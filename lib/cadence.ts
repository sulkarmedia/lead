// Follow-up cadence. Offsets are measured from an anchor: lead creation for "no_reply", the lead's
// last inbound message for "went_quiet". After the base steps the lead moves to nurture with monthly
// touches for up to 6 months. Every scheduled send re-checks state and compliance at send time.
import type { Db } from "./db";
import { maybeOne, q } from "./db";
import type { CadenceStep, Lead, Playbook } from "./db/types";
import { cancelJobs, enqueue } from "./jobs";

export const DEFAULT_NO_REPLY: CadenceStep[] = [
  { after: "2h", channel: "sms", angle: "a simple, easy-to-answer question about what they asked for" },
  { after: "1d", channel: "both", angle: "a matching offer, model or product from the knowledge items" },
  { after: "3d", channel: "sms", angle: "a current incentive from the knowledge items, if any; otherwise a reason to visit" },
  { after: "7d", channel: "email", angle: "trade-in or value: what they could get for what they have now" },
  { after: "14d", channel: "sms", angle: "social proof: why other customers chose this business" },
  { after: "30d", channel: "both", angle: "a polite final check: should I close your file?" },
];

export const DEFAULT_WENT_QUIET: CadenceStep[] = [
  { after: "1d", channel: "sms", angle: "pick up where the conversation left off with one simple question" },
  { after: "3d", channel: "sms", angle: "a helpful piece of value related to what they told you" },
  { after: "7d", channel: "both", angle: "a polite final check: should I close your file?" },
];

export const NURTURE_MONTHS = 6;
const NURTURE_STEP: CadenceStep = { after: "30d", channel: "email", angle: "a light monthly check-in with something new from the knowledge items" };

export function parseOffset(s: string): number {
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(s.trim());
  if (!m) throw new Error(`bad cadence offset ${s}`);
  const n = Number(m[1]);
  return n * { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[m[2] as "m" | "h" | "d" | "w"];
}

export function stepsFor(playbook: Pick<Playbook, "cadence"> | null, kind: Lead["cadence_kind"]): CadenceStep[] {
  const custom = playbook && typeof playbook.cadence === "object" ? playbook.cadence : null;
  const base = kind === "no_reply" ? custom?.no_reply ?? DEFAULT_NO_REPLY : custom?.went_quiet ?? DEFAULT_WENT_QUIET;
  return [...base, ...Array.from({ length: NURTURE_MONTHS }, () => NURTURE_STEP)];
}

/** Absolute run time for step `index` (0-based). Base steps offset from the anchor; nurture steps chain monthly. */
export function stepRunAt(steps: CadenceStep[], index: number, anchor: Date, baseLen: number): Date {
  if (index < baseLen) return new Date(anchor.getTime() + parseOffset(steps[index].after));
  const lastBase = anchor.getTime() + parseOffset(steps[baseLen - 1].after);
  return new Date(lastBase + (index - baseLen + 1) * parseOffset(NURTURE_STEP.after));
}

const STOP_STAGES = new Set(["appointment_set", "showed", "sold", "lost"]);

export function cadenceShouldStop(lead: Pick<Lead, "ai_status" | "stage" | "opted_out_sms_at" | "opted_out_email_at" | "touch_count" | "deleted_at" | "phone_e164" | "email">, maxTouches: number): string | null {
  if (lead.deleted_at) return "deleted";
  if (lead.ai_status !== "active") return `ai_${lead.ai_status}`;
  if (STOP_STAGES.has(lead.stage)) return `stage_${lead.stage}`;
  const smsOpen = !!lead.phone_e164 && !lead.opted_out_sms_at;
  const emailOpen = !!lead.email && !lead.opted_out_email_at;
  if (!smsOpen && !emailOpen) return "opted_out";
  if (lead.touch_count >= maxTouches) return "max_touches";
  return null;
}

/** Schedule the lead's next follow-up (replacing any queued one). Returns the run time or null if the cadence is over. */
export async function scheduleNextFollowup(db: Db, leadId: string): Promise<Date | null> {
  const lead = await maybeOne<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (!lead) return null;
  const pb = await maybeOne<Playbook>(db, "select p.* from lead_sources s join playbooks p on p.id = s.playbook_id where s.id = $1", [lead.source_id]);
  await cancelJobs(db, leadId, ["followup"]);
  if (cadenceShouldStop(lead, pb?.max_touches ?? 14)) return null;
  const steps = stepsFor(pb, lead.cadence_kind);
  const baseLen = steps.length - NURTURE_MONTHS;
  if (lead.cadence_step >= steps.length) return null;
  const anchor = lead.cadence_kind === "went_quiet" && lead.last_inbound_at ? lead.last_inbound_at : lead.created_at;
  const runAt = stepRunAt(steps, lead.cadence_step, anchor, baseLen);
  await enqueue(db, {
    orgId: lead.org_id, leadId, kind: "followup", runAt,
    payload: { step: lead.cadence_step, kind: lead.cadence_kind, nurture: lead.cadence_step >= baseLen },
    dedupeKey: `followup:${leadId}:${lead.cadence_kind}:${lead.cadence_step}`,
  });
  await q(db, "update leads set next_action_at = $2 where id = $1", [leadId, runAt]);
  return runAt;
}

/** A reply restarts the cadence as "went quiet" from the lead's latest message. */
export async function restartAsWentQuiet(db: Db, leadId: string) {
  await q(db, "update leads set cadence_kind = 'went_quiet', cadence_step = 0 where id = $1", [leadId]);
  return scheduleNextFollowup(db, leadId);
}

export async function stopCadence(db: Db, leadId: string) {
  await cancelJobs(db, leadId, ["followup"]);
  await q(db, "update leads set next_action_at = null where id = $1", [leadId]);
}
