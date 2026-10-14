// npm run evals — runs every scripted conversation in tests/agent-evals/*.yaml against the real
// model (ANTHROPIC_API_KEY), applies the same guards production uses, and checks expectations.
// A prompt change ships only at 90% or better. Flags: --offline (harness smoke test with the
// offline stand-in), --filter <substr>, --concurrency <n>, --json <file>.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DateTime } from "luxon";
import { anthropicModel, type AgentModel } from "../../lib/agent/model";
import { offlineModel } from "../../lib/agent/offline";
import { SYSTEM_PROMPT, PROMPT_VERSION, renderKnowledge, renderPlaybook } from "../../lib/agent/prompt";
import { renderLiveContext, type AgentTrigger } from "../../lib/agent/context";
import { runGuards } from "../../lib/agent/guards";
import { extractedToRecord, type AgentOutput } from "../../lib/agent/schema";
import { formatSlot, slotId, type Slot } from "../../lib/booking/slots";
import { DEMO_KNOWLEDGE, loadPlaybookYaml } from "../../lib/seed";
import type { KnowledgeItem, Message, Playbook } from "../../lib/db/types";

interface EvalMessage { from: "lead" | "ai" | "rep"; body: string; channel?: "sms" | "email"; ago_minutes?: number }
interface Expect {
  action?: string | string[];
  final?: "send" | "handoff" | "no_send" | "book" | "stop" | Array<"send" | "handoff" | "no_send" | "book" | "stop">;
  intent?: string | string[];
  warm?: boolean;
  guard?: "pass" | "fail";
  must_not_contain?: string[];
  must_contain_any?: string[];
  must_match?: string;
  language?: "es" | "en";
  extracted?: Record<string, string>;
  offers_two_slots?: boolean;
  book_slot_index?: number;
  stage_suggestion?: string | string[];
}
interface EvalCase {
  id: string;
  description?: string;
  trigger?: "reply" | "first_touch" | "followup" | "resume" | "no_show";
  channel?: "sms" | "email";
  followup?: { step: number; total: number; angle: string };
  lead?: { first_name?: string; last_name?: string; answers?: Record<string, unknown>; qualification?: Record<string, unknown>; stage?: string; email?: boolean; campaign_name?: string; ad_name?: string };
  knowledge?: "default" | "none" | Array<{ kind: string; title: string; body: string }>;
  extra_knowledge?: Array<{ kind: string; title: string; body: string }>;
  playbook?: Partial<Playbook>;
  slots?: boolean;
  messages?: EvalMessage[];
  expect: Expect;
}

const ORG = { name: "BMW of Elmhurst", address: "100 W Lake St, Elmhurst, IL 60126", phone: "+16305550100", website_url: "https://example.com", industry: "automotive" };
const AT = new Date("2026-10-14T18:00:00Z"); // Wed 1:00pm CDT
const TZ = "America/Chicago";

function evalSlots(): Slot[] {
  const base = DateTime.fromJSDate(AT, { zone: TZ }).startOf("day");
  const times: Array<[number, number, number]> = [[1, 10, 0], [1, 15, 0], [2, 9, 30], [2, 14, 0], [3, 11, 0], [3, 16, 30]];
  return times.map(([d, h, m]) => {
    const start = base.plus({ days: d }).set({ hour: h, minute: m }).toJSDate();
    return { id: slotId(start, null), start, end: new Date(start.getTime() + 45 * 60_000), userId: null };
  });
}

function buildRequest(c: EvalCase, pb: Playbook, slots: Slot[]) {
  const knowledge: KnowledgeItem[] = (c.knowledge === "none" ? [] : Array.isArray(c.knowledge) ? c.knowledge : DEMO_KNOWLEDGE)
    .concat(c.extra_knowledge ?? [])
    .map((k, i) => ({ id: `k${i}`, org_id: "o", kind: k.kind, title: k.title, body: k.body, source_url: null, active: true }));
  const msgs = c.messages ?? [];
  const messages: Message[] = msgs.map((m, i) => {
    const created = new Date(AT.getTime() - (m.ago_minutes ?? (msgs.length - i) * 3) * 60_000);
    return {
      id: `m${i}`, org_id: "o", lead_id: "l", channel: m.channel ?? "sms", direction: m.from === "lead" ? "inbound" : "outbound",
      author: m.from === "lead" ? "lead" : m.from === "ai" ? "ai" : "user", author_user_id: null, body: m.body, subject: null,
      status: m.from === "lead" ? "received" : "sent", blocked_reason: null, provider_message_id: null, ai_run_id: null, consent_record_id: null,
      guard_result: null, is_automated: m.from === "ai", is_reply: false, purpose: null, to_address: null, from_address: null, dry_run: true,
      error: null, sent_at: created, created_at: created,
    } as Message;
  });
  const trigger: AgentTrigger =
    c.trigger === "first_touch" ? { kind: "first_touch", channel: c.channel ?? "sms" }
    : c.trigger === "followup" ? { kind: "followup", step: c.followup?.step ?? 0, totalSteps: c.followup?.total ?? 12, angle: c.followup?.angle ?? "a simple question", channel: c.channel ?? "sms" }
    : c.trigger === "resume" ? { kind: "resume", reason: "no rep reply within the SLA" }
    : c.trigger === "no_show" ? { kind: "no_show" }
    : { kind: "reply" };
  const lead = {
    full_name: [c.lead?.first_name ?? "Maria", c.lead?.last_name ?? "Garcia"].join(" "), first_name: c.lead?.first_name ?? "Maria",
    phone_e164: "+16305550199", email: c.lead?.email === false ? null : "maria@example.com", zip: "60126", stage: (c.lead?.stage ?? "contacted") as any,
    warm: false, campaign_name: c.lead?.campaign_name ?? "Pre-order | X5", ad_name: c.lead?.ad_name ?? "X5 carousel",
    answers: c.lead?.answers ?? { which_model_are_you_interested_in: "X5" }, qualification: c.lead?.qualification ?? { model_interest: "X5" },
  };
  const missing = Object.entries(pb.qualification_fields).filter(([k, f]) => f.required && !lead.qualification?.[k]).map(([k]) => k);
  const live = renderLiveContext({ at: AT, tz: TZ, businessOpen: true, repName: "Sam Rivera", lead, slots, messages, trigger, smsAvailable: true, missing });
  return { request: { system: SYSTEM_PROMPT, playbook: renderPlaybook(ORG, pb), knowledge: renderKnowledge(knowledge), live }, knowledge, trigger, messages };
}

const SPANISH = /\b(hola|gracias|usted|tu|tú|cuándo|cuando|puede|podemos|quieres|quiere|le|nos|con gusto|está|esta semana|cita|visitarnos)\b/i;
const asList = <T,>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

function check(c: EvalCase, o: AgentOutput, guard: ReturnType<typeof runGuards>, slots: Slot[], pb: Playbook): string[] {
  const e = c.expect;
  const fails: string[] = [];
  const body = o.message?.body ?? "";
  const lower = body.toLowerCase();
  const final =
    !guard.ok ? (guard.handoff || o.action === "handoff" ? "handoff" : "no_send")
    : o.action === "reply" ? (body ? "send" : "no_send")
    : o.action === "no_reply" ? "no_send"
    : o.action;
  const acts = asList(e.action);
  if (acts && !acts.includes(o.action)) fails.push(`action ${o.action} not in [${acts}]`);
  const finals = asList(e.final);
  if (finals && !finals.includes(final as never)) fails.push(`final ${final} not in [${finals}] (guard: ${guard.failures.join(",") || "ok"})`);
  const intents = asList(e.intent);
  if (intents && !intents.includes(o.intent)) fails.push(`intent ${o.intent} not in [${intents}]`);
  if (e.warm !== undefined && o.warm !== e.warm) fails.push(`warm ${o.warm} != ${e.warm}`);
  if (e.guard === "pass" && !guard.ok) fails.push(`guard failed: ${guard.failures.join(",")}`);
  if (e.guard === "fail" && guard.ok) fails.push("guard passed but should fail");
  for (const p of e.must_not_contain ?? []) if (lower.includes(p.toLowerCase())) fails.push(`contains forbidden "${p}"`);
  if (e.must_contain_any && !e.must_contain_any.some((p) => lower.includes(p.toLowerCase()))) fails.push(`contains none of [${e.must_contain_any}]`);
  if (e.must_match && !new RegExp(e.must_match, "iu").test(body)) fails.push(`does not match /${e.must_match}/`);
  if (e.language === "es" && !SPANISH.test(body)) fails.push("not Spanish");
  if (e.extracted) {
    const ex = extractedToRecord(o, Object.keys(pb.qualification_fields));
    for (const [k, re] of Object.entries(e.extracted)) if (!new RegExp(re, "i").test(ex[k] ?? "")) fails.push(`extracted.${k}="${ex[k] ?? ""}" !~ /${re}/`);
  }
  if (e.offers_two_slots) {
    const hits = slots.filter((s) => {
      const t = DateTime.fromJSDate(s.start, { zone: TZ });
      const time = t.toFormat("h:mm").replace(":00", "");
      const day = t.toFormat("cccc").toLowerCase();
      return lower.includes(day.slice(0, 3)) && (lower.includes(t.toFormat("h:mm")) || new RegExp(`\\b${time}\\s?(am|pm|a\\.m|p\\.m)`).test(lower));
    });
    if (hits.length < 2) fails.push(`offers ${hits.length} listed slots, expected 2`);
  }
  if (e.book_slot_index !== undefined && o.book_slot_id !== slots[e.book_slot_index]?.id) fails.push(`book_slot_id ${o.book_slot_id} != ${slots[e.book_slot_index]?.id}`);
  const stages = asList(e.stage_suggestion);
  if (stages && !stages.includes(String(o.stage_suggestion))) fails.push(`stage_suggestion ${o.stage_suggestion} not in [${stages}]`);
  if (o.message?.channel === "sms" && body.length > 320) fails.push(`sms ${body.length} chars`);
  return fails;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;
  const concurrency = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 4;
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  if (!offline && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Use --offline to smoke-test the harness.");
    process.exit(2);
  }
  const model: AgentModel = offline ? offlineModel : anthropicModel;
  const dir = join(process.cwd(), "tests/agent-evals");
  const cases: EvalCase[] = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()
    .flatMap((f) => (parse(readFileSync(join(dir, f), "utf8")).cases as EvalCase[]).map((c) => ({ ...c, id: `${f.replace(".yaml", "")}/${c.id}` })))
    .filter((c) => !filter || c.id.includes(filter));
  const basePb = loadPlaybookYaml();
  const results: Array<{ id: string; pass: boolean; fails: string[]; output?: AgentOutput; error?: string }> = [];
  let i = 0;
  async function worker() {
    while (i < cases.length) {
      const c = cases[i++];
      const pb = { ...basePb, id: "pb", org_id: "o", version: 1, bridge_message_allowed: true, max_touches: 14, approved_at: null, ...c.playbook } as Playbook;
      const slots = c.slots === false ? [] : evalSlots();
      const { request, knowledge, trigger, messages } = buildRequest(c, pb, slots);
      let res = await model.generate(request, { timeoutMs: 60_000 });
      if (!res.ok && res.kind === "unavailable") res = await model.generate(request, { timeoutMs: 60_000 });
      if (!res.ok) {
        results.push({ id: c.id, pass: false, fails: [`model error: ${res.kind} ${res.error}`] });
        continue;
      }
      const lastInbound = [...messages].reverse().find((m) => m.author === "lead");
      const guard = runGuards(res.output, {
        trigger: trigger.kind, businessName: ORG.name, knowledgeText: knowledge.map((k) => `${k.title}\n${k.body}`).join("\n"),
        neverSay: pb.never_say ?? [], offeredSlotIds: slots.map((s) => s.id),
        unansweredAiMessages: messages.filter((m) => m.author === "ai" && (!lastInbound || m.created_at > lastInbound.created_at)).map((m) => m.created_at),
        now: AT, isFirstMessage: !messages.some((m) => m.direction === "outbound"),
      });
      const fails = check(c, res.output, guard, slots, pb);
      results.push({ id: c.id, pass: fails.length === 0, fails, output: res.output });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.pass ? "" : `\n      ${r.fails.join("\n      ")}\n      → ${r.output?.action ?? ""} ${JSON.stringify(r.output?.message?.body ?? "")}`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const rate = results.length ? passed / results.length : 0;
  console.log(`\n${passed}/${results.length} passed (${(rate * 100).toFixed(1)}%) · prompt ${PROMPT_VERSION} · ${offline ? "offline stand-in" : process.env.AGENT_MODEL ?? "claude-sonnet-5-5"}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ prompt_version: PROMPT_VERSION, rate, results }, null, 2));
  if (!offline && rate < 0.9) {
    console.error("Below the 90% gate: this prompt version must not ship.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
