// One handler per job kind. Handlers re-read lead state; a stale job is a no-op, not an error.
import { DateTime } from "luxon";
import type { Db } from "../lib/db";
import { maybeOne, one, q } from "../lib/db";
import type { Appointment, Job, Lead, Org } from "../lib/db/types";
import { now } from "../lib/clock";
import { decrypt } from "../lib/crypto";
import { env } from "../lib/env";
import { enqueue } from "../lib/jobs";
import { log } from "../lib/log";
import { agentReply, firstTouch, followup } from "../lib/conversation";
import { deliverMessage } from "../lib/messaging/send";
import { backupUserIds, repRepliedSince, SLA_RESUME_MIN } from "../lib/handoff";
import { addBusinessMinutes } from "../lib/booking/hours";
import { loadAvailability } from "../lib/booking/book";
import { leadLink, notifyUser } from "../lib/notify";
import { promptOutcome, sendReminder } from "../lib/appointments";
import { buildCapiEvent, sendCapiEvents } from "../lib/integrations/capi";
import { buildAdf } from "../lib/integrations/adf";
import { postWebhook } from "../lib/integrations/webhooks";
import { getSenders } from "../lib/messaging/sender";
import { createCalendarEvent, deleteCalendarEvent } from "../lib/integrations/google";
import { dailyDigest } from "../lib/digest";
import { pollMetaForms } from "../lib/integrations/meta-sync";

export class Reschedule extends Error {
  constructor(public runAt: Date) { super(`reschedule to ${runAt.toISOString()}`); }
}

export async function handleJob(db: Db, job: Job): Promise<void> {
  const p = job.payload as Record<string, any>;
  switch (job.kind) {
    case "first_touch":
      await firstTouch(db, job.lead_id!);
      return;
    case "agent_reply":
      await agentReply(db, job.lead_id!, p);
      return;
    case "followup":
      await followup(db, job.lead_id!, { step: p.step, kind: p.kind });
      return;
    case "scheduled_send":
      await deliverMessage(db, p.message_id);
      return;
    case "handoff_sla":
      await handoffSla(db, job);
      return;
    case "reminder":
      await sendReminder(db, p.appointment_id, p.which);
      return;
    case "appointment_check":
      await promptOutcome(db, p.appointment_id);
      return;
    case "capi_event":
      await capiEvent(db, p.capi_event_id);
      return;
    case "crm_push":
      await crmPush(db, job);
      return;
    case "webhook_out":
      await webhookOut(db, job);
      return;
    case "calendar_sync":
      await calendarSync(db, p.op, p.appointment_id);
      return;
    case "daily_digest":
      await dailyDigest(db, job.org_id);
      return;
    case "meta_poll":
      await pollMetaForms(db, job.org_id);
      return;
    default:
      log.warn("job.unhandled", { kind: job.kind, job_id: job.id });
  }
}

async function handoffSla(db: Db, job: Job) {
  const p = job.payload as { stage: "escalate" | "resume"; handoff_at: string };
  const lead = await one<Lead>(db, "select * from leads where id = $1", [job.lead_id]);
  const handoffAt = new Date(p.handoff_at);
  // Stale: the thread was handed back, re-handed off, or a rep already replied.
  if (lead.ai_status !== "paused" || !lead.handoff_at || lead.handoff_at.getTime() !== handoffAt.getTime()) return;
  if (await repRepliedSince(db, lead.id, handoffAt)) return;
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  if (p.stage === "escalate") {
    for (const uid of await backupUserIds(db, org, lead.assigned_user_id)) {
      await notifyUser(db, { orgId: org.id, userId: uid, leadId: lead.id, kind: "sla_miss", subject: `Missed handoff: ${lead.full_name ?? "a lead"} is waiting`, body: `No rep reply in 10 minutes.\n${(lead.summary ?? "").split("\n").slice(0, 3).join("\n")}\n${leadLink(lead.id)}` });
    }
    const avail = await loadAvailability(db, org.id, lead.assigned_user_id);
    const resumeAt = addBusinessMinutes(handoffAt, SLA_RESUME_MIN, avail?.weekly_hours, org.timezone);
    await enqueue(db, { orgId: org.id, leadId: lead.id, kind: "handoff_sla", runAt: resumeAt, payload: { stage: "resume", handoff_at: p.handoff_at }, dedupeKey: `sla2:${lead.id}:${p.handoff_at}` });
    return;
  }
  // 30 minutes: the AI resumes and offers times to book.
  await q(db, "update leads set ai_status = 'active', ai_paused_reason = null where id = $1", [lead.id]);
  await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, status, purpose, created_at) values ($1, $2, 'system', 'internal', 'system', $3, 'received', 'note', $4)`,
    [org.id, lead.id, "No rep reply within 30 minutes: AI resumed and offered times.", now()]);
  await agentReply(db, lead.id, { trigger: "resume" });
}

async function capiEvent(db: Db, capiEventId: string) {
  const ev = await one<{ id: string; org_id: string; lead_id: string; event_name: string; event_time: Date; status: string }>(db, "select * from capi_events where id = $1", [capiEventId]);
  if (ev.status === "sent") return;
  const lead = await one<Lead>(db, "select * from leads where id = $1", [ev.lead_id]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [ev.org_id]);
  const integ = await maybeOne<{ secret_enc: string | null; config: { dataset_id?: string; test_event_code?: string } }>(
    db, "select secret_enc, config from integrations where org_id = $1 and kind = 'capi' and status = 'connected'", [org.id]);
  const datasetId = integ?.config.dataset_id ?? org.capi_dataset_id;
  if (!lead.meta_lead_id || !datasetId || !integ?.secret_enc) {
    await q(db, "update capi_events set status = 'skipped', response = $2 where id = $1", [ev.id, JSON.stringify({ reason: !lead.meta_lead_id ? "no_meta_lead_id" : "capi_not_connected" })]);
    return;
  }
  const event = buildCapiEvent({ stage: ev.event_name, at: ev.event_time, metaLeadId: lead.meta_lead_id });
  if (env.dryRun) {
    await q(db, "update capi_events set status = 'sent', attempts = attempts + 1, response = $2 where id = $1", [ev.id, JSON.stringify({ dry_run: true, event })]);
    return;
  }
  try {
    const res = await sendCapiEvents(datasetId, decrypt(integ.secret_enc), [event], integ.config.test_event_code);
    await q(db, "update capi_events set status = 'sent', attempts = attempts + 1, response = $2 where id = $1", [ev.id, JSON.stringify(res)]);
  } catch (e) {
    await q(db, "update capi_events set status = 'failed', attempts = attempts + 1, response = $2 where id = $1", [ev.id, JSON.stringify({ error: (e as Error).message })]);
    throw e; // job retries with backoff
  }
}

async function crmPush(db: Db, job: Job) {
  const p = job.payload as { stage: string };
  const lead = await one<Lead>(db, "select * from leads where id = $1", [job.lead_id]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  if (p.stage !== "qualified" && p.stage !== "appointment_set") return; // ADF on qualified and appointment_set
  const adf = await maybeOne<{ config: { address?: string } }>(db, "select config from integrations where org_id = $1 and kind = 'adf_email' and status = 'connected'", [org.id]);
  if (!adf?.config.address) return;
  const appt = await maybeOne<Appointment>(db, "select * from appointments where lead_id = $1 and status in ('booked', 'confirmed') order by starts_at desc limit 1", [lead.id]);
  const qual = (lead.qualification ?? {}) as Record<string, string>;
  const xml = buildAdf({
    requestDate: now(),
    lead: { id: lead.id, firstName: lead.first_name, lastName: lead.last_name, phone: lead.phone_e164, email: lead.email, zip: lead.zip },
    vehicle: qual.model_interest || qual.vehicle ? { make: (org.industry === "automotive" ? (org.name.match(/BMW|Toyota|Honda|Ford|Chevrolet|Nissan|Hyundai|Kia|Audi|Mercedes|Lexus|Subaru|Mazda|Jeep|Ram|GMC|Volkswagen|Volvo/i)?.[0] ?? null) : null), model: qual.model_interest ?? qual.vehicle, trim: qual.configuration ?? null, interest: qual.payment_type === "lease" ? "lease" : "buy" } : null,
    tradeIn: qual.trade_in ?? null,
    vendorName: org.name,
    providerName: env.appName,
    providerUrl: env.appUrl,
    comments: `Stage: ${p.stage}. ${lead.summary ?? ""}`.trim(),
    appointmentAt: appt?.starts_at ?? null,
    threadUrl: leadLink(lead.id),
  });
  await getSenders().email({
    from: `"${env.appName} Leads" <leads@${env.postmarkSendingDomain}>`, to: adf.config.address,
    subject: `Lead: ${lead.full_name ?? lead.id} (${p.stage})`, text: xml, stream: "transactional",
  });
  log.info("crm.adf_sent", { org_id: org.id, lead_id: lead.id, stage: p.stage });
}

async function webhookOut(db: Db, job: Job) {
  const p = job.payload as { event: string; data: Record<string, unknown>; first_attempt_at: string };
  if (now().getTime() - new Date(p.first_attempt_at).getTime() > 24 * 3600_000) {
    log.warn("webhook.gave_up", { org_id: job.org_id, event: p.event });
    return;
  }
  const hook = await maybeOne<{ config: { url?: string }; secret_enc: string | null }>(db, "select config, secret_enc from integrations where org_id = $1 and kind = 'crm_webhook' and status = 'connected'", [job.org_id]);
  if (!hook?.config.url || !hook.secret_enc) return;
  const lead = job.lead_id ? await maybeOne<Lead>(db, "select * from leads where id = $1", [job.lead_id]) : null;
  const payload = {
    ...p.data,
    lead: lead && {
      id: lead.id, stage: lead.stage, first_name: lead.first_name, last_name: lead.last_name, phone: lead.phone_e164, email: lead.email, zip: lead.zip,
      meta_lead_id: lead.meta_lead_id, campaign_name: lead.campaign_name, ad_name: lead.ad_name, qualification: lead.qualification, summary: lead.summary,
      opted_out_sms: !!lead.opted_out_sms_at, opted_out_email: !!lead.opted_out_email_at, url: leadLink(lead.id),
    },
  };
  if (env.dryRun) {
    log.info("dry_run.webhook", { org_id: job.org_id, event: p.event });
    return;
  }
  await postWebhook(hook.config.url, decrypt(hook.secret_enc), p.event, payload, now());
}

async function calendarSync(db: Db, op: "create" | "delete", appointmentId: string) {
  const a = await one<Appointment>(db, "select * from appointments where id = $1", [appointmentId]);
  if (!a.user_id) return;
  if (op === "create") {
    if (a.google_event_id) return;
    const lead = await one<Lead>(db, "select * from leads where id = $1", [a.lead_id]);
    const org = await one<Org>(db, "select * from organizations where id = $1", [a.org_id]);
    const id = await createCalendarEvent(db, a.org_id, a.user_id, {
      summary: `${lead.full_name ?? "Lead"} — ${a.kind === "call" ? "call" : "appointment"}`,
      description: `Phone: ${lead.phone_e164 ?? "-"}\nEmail: ${lead.email ?? "-"}\n${lead.summary ?? ""}\nThread: ${leadLink(lead.id)}`,
      start: a.starts_at, end: a.ends_at, location: a.kind === "in_person" ? org.address : null,
    });
    if (id) await q(db, "update appointments set google_event_id = $2 where id = $1", [a.id, id]);
  } else if (a.google_event_id) {
    await deleteCalendarEvent(db, a.org_id, a.user_id, a.google_event_id);
  }
}

/** Recurring work the worker schedules for itself (idempotent via dedupe keys). */
export async function scheduleRecurring(db: Db) {
  const orgs = await q<Org>(db, "select * from organizations where status in ('live', 'onboarding')");
  for (const org of orgs) {
    // 6pm owner digest in the org's time zone.
    const local = DateTime.fromJSDate(now(), { zone: org.timezone });
    let at = local.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
    if (at <= local) at = at.plus({ days: 1 });
    await enqueue(db, { orgId: org.id, kind: "daily_digest", runAt: at.toJSDate(), dedupeKey: `digest:${org.id}:${at.toISODate()}` });
    // Meta safety-net poll every 15 minutes for orgs with native Meta intake.
    const meta = await maybeOne(db, "select 1 from integrations where org_id = $1 and kind = 'meta' and status = 'connected'", [org.id]);
    if (meta) {
      const slot = Math.floor(now().getTime() / (15 * 60_000));
      await enqueue(db, { orgId: org.id, kind: "meta_poll", runAt: new Date((slot + 1) * 15 * 60_000), dedupeKey: `metapoll:${org.id}:${slot + 1}` });
    }
  }
}
