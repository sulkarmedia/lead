// Playbook test chat: runs the agent against a saved playbook with a fake lead and the chat so far,
// then runs the guards. Sends nothing and writes no leads, messages or ai_runs.
import { DateTime } from "luxon";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { maybeOne, q, service } from "@/lib/db";
import type { KnowledgeItem, Playbook } from "@/lib/db/types";
import { now } from "@/lib/clock";
import { json } from "@/lib/http";
import { getModel } from "@/lib/agent/model";
import { renderKnowledge, renderPlaybook, SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { runGuards } from "@/lib/agent/guards";
import { openSlots } from "@/lib/booking/book";
import { formatSlot } from "@/lib/booking/slots";

export const dynamic = "force-dynamic";

const Body = z.object({
  playbook_id: z.string().uuid(),
  channel: z.enum(["sms", "email"]).default("sms"),
  lead: z.object({ first_name: z.string().max(60).default("Taylor"), answers: z.record(z.string(), z.string()).default({}) }).default({ first_name: "Taylor", answers: {} }),
  messages: z.array(z.object({ from: z.enum(["lead", "ai"]), body: z.string().max(2000) })).max(40),
});

export async function POST(req: Request) {
  const ctx = await requireAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const { playbook_id, channel, lead, messages } = parsed.data;
  const playbook = await maybeOne<Playbook>(service(), "select * from playbooks where id = $1 and org_id = $2", [playbook_id, ctx.org.id]);
  if (!playbook) return json({ error: "playbook not found" }, 404);
  const knowledge = await q<KnowledgeItem>(service(), "select * from knowledge_items where org_id = $1 and active order by kind, title, id", [ctx.org.id]);
  const org = ctx.org;
  const tz = org.timezone;
  const at = now();
  const slots = ["appointment", "call", "reservation"].includes(playbook.goal)
    ? await openSlots(service(), { org_id: org.id, assigned_user_id: null }, playbook.booking).catch(() => [])
    : [];
  const isFirst = !messages.some((m) => m.from === "ai");
  const lastLead = [...messages].reverse().find((m) => m.from === "lead");
  const trigger = isFirst && !lastLead ? "first_touch" : "reply";
  // Simulated timestamps: one minute apart, ending now.
  const stamp = (i: number) => DateTime.fromJSDate(new Date(at.getTime() - (messages.length - i) * 60_000), { zone: tz }).toFormat("ccc LLL d h:mma");
  const qualification = Object.fromEntries(Object.keys(playbook.qualification_fields ?? {}).filter((k) => lead.answers[k]).map((k) => [k, lead.answers[k]]));
  const missing = Object.entries(playbook.qualification_fields ?? {}).filter(([k, f]) => f.required && !qualification[k]).map(([k]) => k);
  const instruction = trigger === "first_touch"
    ? `This is the FIRST message to this lead. Name the business, introduce yourself as its virtual assistant, reference what they asked about on the form, and end with one easy question.${channel === "sms" ? ' End the SMS with "Reply STOP to opt out."' : ""}`
    : "The lead just wrote to you (latest LEAD messages above). Respond to them.";

  const live = `NOW: ${DateTime.fromJSDate(at, { zone: tz }).toFormat("cccc LLL d yyyy, h:mma")} in the lead's time zone (${tz}).
ASSIGNED REP: (unassigned — say 'a member of our team')
(TEST CHAT: the owner is testing the playbook. Behave exactly as with a real lead.)

LEAD
Name: ${lead.first_name} Tester (first name: ${lead.first_name})
Phone on file: yes · Email on file: yes · ZIP: (unknown)
Stage: ${messages.some((m) => m.from === "lead") ? "engaged" : "new"} · Warm: no
Came from: a lead form
Form answers: ${JSON.stringify(lead.answers)}
Qualification so far: ${JSON.stringify(qualification)}
Missing required fields: ${missing.length ? missing.join(", ") : "none"}

OPEN SLOTS (lead's local time; offer exactly two; use these ids only)
${slots.length ? slots.map((s) => `- ${s.id}: ${formatSlot(s, tz)}`).join("\n") : "- (none available — offer to have the team reach out to schedule)"}

CONVERSATION (oldest first)
${messages.length ? messages.map((m, i) => `[${stamp(i)}] ${m.from === "lead" ? "LEAD" : "YOU (assistant)"} via ${channel}: ${m.body}`).join("\n") : "(no messages yet)"}

TASK
${instruction}
Write message.channel = "${channel}".${channel === "email" ? " Include a subject." : " Set subject to null."}`;

  const res = await getModel().generate({ system: SYSTEM_PROMPT, playbook: renderPlaybook(org, playbook), knowledge: renderKnowledge(knowledge), live });
  if (!res.ok) return json({ ok: false, error: res.error, kind: res.kind });
  const lastLeadIndex = messages.map((m) => m.from).lastIndexOf("lead");
  const guard = runGuards(res.output, {
    trigger,
    businessName: org.name,
    knowledgeText: knowledge.map((k) => `${k.title}\n${k.body}`).join("\n"),
    neverSay: playbook.never_say ?? [],
    offeredSlotIds: slots.map((s) => s.id),
    unansweredAiMessages: messages.slice(lastLeadIndex + 1).filter((m) => m.from === "ai").map(() => at),
    now: at,
    isFirstMessage: isFirst,
  });
  return json({
    ok: true,
    output: res.output,
    guard,
    model: res.usage.model,
    approve_before_send: playbook.approve_before_send,
    slots: slots.map((s) => ({ id: s.id, label: formatSlot(s, tz) })),
  });
}
