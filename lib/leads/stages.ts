// Stage changes. Every change writes stage_events and schedules the follow-on work
// (Conversions API event, CRM push, outbound webhooks) as jobs.
import type { Db } from "../db";
import { maybeOne, one, q } from "../db";
import type { LeadStage } from "../db/types";
import { enqueue } from "../jobs";
import { now } from "../clock";

export const FORWARD_ORDER: LeadStage[] = ["new", "contacted", "engaged", "qualified", "appointment_set", "showed", "sold"];
export const CAPI_STAGES: LeadStage[] = ["qualified", "appointment_set", "showed", "sold"];
export const CRM_STAGES: LeadStage[] = ["qualified", "appointment_set", "showed", "sold"];
const WEBHOOK_EVENTS: Partial<Record<LeadStage, string>> = {
  qualified: "lead.qualified",
  appointment_set: "appointment.set",
  showed: "appointment.showed",
};

/** True when `to` is further along the main pipeline than `from` (side exits handled separately). */
export function isForward(from: LeadStage, to: LeadStage): boolean {
  const a = FORWARD_ORDER.indexOf(from);
  const b = FORWARD_ORDER.indexOf(to);
  if (b === -1) return true; // nurture/lost are always allowed as exits
  if (a === -1) return true; // coming back from nurture/lost
  return b > a;
}

/**
 * Move a lead to a stage. With `onlyForward`, moves that would go backwards are ignored
 * (the AI and automations use this; a rep dragging a card does not).
 */
export async function setStage(db: Db, leadId: string, to: LeadStage, actor: string, opts: { onlyForward?: boolean } = {}): Promise<boolean> {
  const lead = await maybeOne<{ org_id: string; stage: LeadStage; meta_lead_id: string | null }>(
    db, "select org_id, stage, meta_lead_id from leads where id = $1 for update", [leadId]);
  if (!lead || lead.stage === to) return false;
  if (opts.onlyForward && !isForward(lead.stage, to)) return false;
  await q(db, "update leads set stage = $2 where id = $1", [leadId, to]);
  const ev = await one<{ id: string }>(
    db,
    "insert into stage_events (org_id, lead_id, from_stage, to_stage, actor, created_at) values ($1, $2, $3, $4, $5, $6) returning id",
    [lead.org_id, leadId, lead.stage, to, actor, now()],
  );
  if (CAPI_STAGES.includes(to)) {
    const capi = await one<{ id: string }>(
      db,
      "insert into capi_events (org_id, lead_id, stage_event_id, event_name, event_time, status) values ($1, $2, $3, $4, $5, $6) returning id",
      [lead.org_id, leadId, ev.id, to, now(), lead.meta_lead_id ? "pending" : "skipped"],
    );
    if (lead.meta_lead_id) await enqueue(db, { orgId: lead.org_id, leadId, kind: "capi_event", payload: { capi_event_id: capi.id }, maxAttempts: 8 });
  }
  if (CRM_STAGES.includes(to)) {
    await enqueue(db, { orgId: lead.org_id, leadId, kind: "crm_push", payload: { stage: to, stage_event_id: ev.id }, dedupeKey: `crm:${ev.id}` });
  }
  const webhookEvent = WEBHOOK_EVENTS[to];
  if (webhookEvent) await enqueueWebhook(db, lead.org_id, leadId, webhookEvent, { stage: to });
  return true;
}

export async function enqueueWebhook(db: Db, orgId: string, leadId: string, event: string, data: Record<string, unknown> = {}) {
  const hook = await maybeOne(db, "select 1 from integrations where org_id = $1 and kind = 'crm_webhook' and status = 'connected'", [orgId]);
  if (!hook) return;
  // Retries for 24 hours: 12 attempts with capped exponential backoff.
  await enqueue(db, { orgId, leadId, kind: "webhook_out", payload: { event, data, first_attempt_at: now().toISOString() }, maxAttempts: 12 });
}
