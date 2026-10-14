// Builds the agent's context in cache-friendly order: system prompt, playbook, knowledge (stable per
// tenant), then the live context (time, lead, slots, cadence step, last 30 messages).
import { DateTime } from "luxon";
import type { Db } from "../db";
import { maybeOne, one, q } from "../db";
import type { KnowledgeItem, Lead, Membership, Message, Org, Playbook } from "../db/types";
import { now } from "../clock";
import { loadAvailability, openSlots } from "../booking/book";
import { formatSlot, type Slot } from "../booking/slots";
import { renderKnowledge, renderPlaybook, SYSTEM_PROMPT } from "./prompt";
import type { AgentRequest } from "./model";

export type AgentTrigger =
  | { kind: "first_touch"; channel: "sms" | "email" }
  | { kind: "reply" }
  | { kind: "followup"; step: number; totalSteps: number; angle: string; channel: "sms" | "email" }
  | { kind: "resume"; reason: string }
  | { kind: "no_show" };

export interface AgentContext {
  org: Org;
  lead: Lead;
  playbook: Playbook;
  knowledge: KnowledgeItem[];
  repName: string | null;
  messages: Message[];
  slots: Slot[];
  smsAvailable: boolean;
  emailAvailable: boolean;
  request: AgentRequest;
  isFirstMessage: boolean;
}

export const DEFAULT_PLAYBOOK: Omit<Playbook, "id" | "org_id"> = {
  name: "Default", version: 1, goal: "appointment", goal_detail: null, qualification_fields: {}, warm_rule: null,
  handoff_triggers: ["asks for a price or term not in knowledge", "asks for a person", "complaint or frustration"],
  cadence: "default", send_window: { start: "09:00", end: "20:00" }, tone: null, never_say: [], booking: {},
  intro_template: "Hi {first_name}, this is the virtual assistant at {business_name}. Thanks for reaching out. What can I help you with? Reply STOP to opt out.",
  bridge_message_allowed: true, max_touches: 14, approve_before_send: true, approved_at: null,
};

export async function loadPlaybook(db: Db, lead: Pick<Lead, "source_id" | "org_id">): Promise<Playbook> {
  return (
    (await maybeOne<Playbook>(db, "select p.* from lead_sources s join playbooks p on p.id = s.playbook_id where s.id = $1", [lead.source_id])) ??
    (await maybeOne<Playbook>(db, "select * from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [lead.org_id])) ??
    ({ ...DEFAULT_PLAYBOOK, id: "default", org_id: lead.org_id } as Playbook)
  );
}

function businessOpen(weekly: Record<string, Array<[string, string]>> | undefined, tz: string, at: Date): boolean {
  if (!weekly) return false;
  const l = DateTime.fromJSDate(at, { zone: tz });
  const key = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][l.weekday - 1];
  const m = l.hour * 60 + l.minute;
  return (weekly[key] ?? []).some(([a, b]) => {
    const [ah, am] = a.split(":").map(Number);
    const [bh, bm] = b.split(":").map(Number);
    return m >= ah * 60 + am && m < bh * 60 + bm;
  });
}

function describeMessage(m: Message, tz: string, repName: string | null): string {
  const t = DateTime.fromJSDate(m.created_at, { zone: tz }).toFormat("ccc LLL d h:mma");
  const who = m.author === "lead" ? "LEAD" : m.author === "ai" ? "YOU (assistant)" : m.author === "user" ? `REP ${repName ?? ""}`.trim() : "SYSTEM";
  const status = m.direction === "outbound" && m.status !== "sent" && m.status !== "delivered" ? ` [${m.status}${m.blocked_reason ? `: ${m.blocked_reason}` : ""} — the lead did NOT receive this]` : "";
  return `[${t}] ${who} via ${m.channel}${m.subject ? ` (subject: ${m.subject})` : ""}: ${m.body}${status}`;
}

export async function buildContext(db: Db, leadId: string, trigger: AgentTrigger): Promise<AgentContext> {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  const playbook = await loadPlaybook(db, lead);
  const knowledge = await q<KnowledgeItem>(db, "select * from knowledge_items where org_id = $1 and active order by kind, title, id", [org.id]);
  const rep = lead.assigned_user_id
    ? await maybeOne<Membership>(db, "select * from memberships where org_id = $1 and user_id = $2", [org.id, lead.assigned_user_id])
    : null;
  const messages = (
    await q<Message>(db, `select * from messages where lead_id = $1 and channel in ('sms', 'email', 'note') order by created_at desc limit 30`, [leadId])
  ).reverse();
  const consent = await maybeOne<{ covers_automated: boolean }>(db, "select covers_automated from consent_records where lead_id = $1 and channel = 'sms' order by captured_at desc limit 1", [leadId]);
  const smsAvailable = !!lead.phone_e164 && !lead.opted_out_sms_at && !!consent?.covers_automated;
  const emailAvailable = !!lead.email && !lead.opted_out_email_at;
  const tz = lead.timezone ?? org.timezone;
  const slots = playbook.goal === "appointment" || playbook.goal === "call" || playbook.goal === "reservation" ? await openSlots(db, lead, playbook.booking) : [];
  const orgAvail = await loadAvailability(db, org.id, null);
  const at = now();
  const isFirstMessage = !messages.some((m) => m.direction === "outbound" && (m.status === "sent" || m.status === "delivered") && m.author !== "system");

  const fields = playbook.qualification_fields;
  const missing = Object.entries(fields).filter(([k, f]) => f.required && !lead.qualification?.[k]).map(([k]) => k);

  let instruction: string;
  let channelNote: string;
  switch (trigger.kind) {
    case "first_touch":
      instruction = `This is the FIRST message to this lead. Name the business, introduce yourself as its virtual assistant, reference what they asked about on the form, and end with one easy question.${trigger.channel === "sms" ? ' End the SMS with "Reply STOP to opt out."' : ""}`;
      channelNote = trigger.channel;
      break;
    case "reply":
      instruction = "The lead just wrote to you (latest LEAD messages above). Respond to them.";
      channelNote = lastInboundChannel(messages) ?? (smsAvailable ? "sms" : "email");
      break;
    case "followup":
      instruction = `The lead hasn't replied. Write follow-up ${trigger.step + 1} of ${trigger.totalSteps}. Angle: ${trigger.angle}. Don't repeat earlier messages; keep it short and end with one question.`;
      channelNote = trigger.channel;
      break;
    case "resume":
      instruction = `A team member was asked to take over but hasn't replied in time (${trigger.reason}). Apologize briefly for the wait and offer two specific times to book from OPEN SLOTS.`;
      channelNote = lastInboundChannel(messages) ?? (smsAvailable ? "sms" : "email");
      break;
    case "no_show":
      instruction = "The lead missed their appointment yesterday. Send a short, kind message offering to reschedule, with two specific times from OPEN SLOTS.";
      channelNote = smsAvailable ? "sms" : "email";
      break;
  }

  const live = `NOW: ${DateTime.fromJSDate(at, { zone: tz }).toFormat("cccc LLL d yyyy, h:mma")} in the lead's time zone (${tz}). The business is ${businessOpen(orgAvail?.weekly_hours, org.timezone, at) ? "OPEN" : "CLOSED"} right now.
ASSIGNED REP: ${rep?.display_name ?? "(unassigned — say 'a member of our team')"}

LEAD
Name: ${lead.full_name ?? "(unknown)"} (first name: ${lead.first_name ?? "(unknown)"})
Phone on file: ${lead.phone_e164 ? "yes" : "no"} · Email on file: ${lead.email ? "yes" : "no"} · ZIP: ${lead.zip ?? "(unknown)"}
Stage: ${lead.stage} · Warm: ${lead.warm ? "yes" : "no"}
Came from: ${[lead.campaign_name && `campaign "${lead.campaign_name}"`, lead.ad_name && `ad "${lead.ad_name}"`].filter(Boolean).join(", ") || "a lead form"}
Form answers: ${JSON.stringify(lead.answers ?? {})}
Qualification so far: ${JSON.stringify(lead.qualification ?? {})}
Missing required fields: ${missing.length ? missing.join(", ") : "none"}

OPEN SLOTS (lead's local time; offer exactly two; use these ids only)
${slots.length ? slots.map((s) => `- ${s.id}: ${formatSlot(s, tz)}`).join("\n") : "- (none available — offer to have the team reach out to schedule)"}

CONVERSATION (oldest first)
${messages.length ? messages.map((m) => describeMessage(m, tz, rep?.display_name ?? null)).join("\n") : "(no messages yet)"}

TASK
${instruction}
Write message.channel = "${channelNote}".${channelNote === "email" ? " Include a subject." : " Set subject to null."}`;

  return {
    org, lead, playbook, knowledge, repName: rep?.display_name ?? null, messages, slots, smsAvailable, emailAvailable, isFirstMessage,
    request: { system: SYSTEM_PROMPT, playbook: renderPlaybook(org, playbook), knowledge: renderKnowledge(knowledge), live },
  };
}

function lastInboundChannel(messages: Message[]): "sms" | "email" | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].author === "lead") return messages[i].channel as "sms" | "email";
  return null;
}

export function renderIntroTemplate(tpl: string, org: Pick<Org, "name">, lead: Pick<Lead, "first_name" | "qualification" | "answers">): string {
  const vars: Record<string, string> = {
    first_name: lead.first_name ?? "there",
    business_name: org.name,
    ...Object.fromEntries(Object.entries({ ...(lead.answers ?? {}), ...(lead.qualification ?? {}) }).map(([k, v]) => [k, String(v)])),
  };
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? (k === "model_interest" ? "vehicle" : "")).replace(/\s+/g, " ").replace(/ ([.,?!])/g, "$1").trim();
}
