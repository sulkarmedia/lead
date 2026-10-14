// Appointment lifecycle after booking: reminders, outcome prompt, showed/no-show/sold.
import { DateTime } from "luxon";
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { Appointment, Lead, Org } from "./db/types";
import { now } from "./clock";
import { enqueue } from "./jobs";
import { queueOutbound } from "./messaging/send";
import { setStage } from "./leads/stages";
import { formatSlot } from "./booking/slots";
import { leadLink, notifyUser } from "./notify";
import { checkSend } from "./compliance";

export function reminderText(which: "24h" | "2h", org: Pick<Org, "name" | "address">, a: Pick<Appointment, "starts_at" | "kind">, lead: Pick<Lead, "first_name">, tz: string) {
  const when = which === "24h" ? `tomorrow, ${formatSlot({ start: a.starts_at }, tz).replace(/^\w+ /, "")}` : `today at ${DateTime.fromJSDate(a.starts_at, { zone: tz }).toFormat("h:mma").toLowerCase()}`;
  const where = a.kind === "in_person" && org.address ? ` at ${org.address}` : a.kind === "call" ? " (we'll call you)" : "";
  return `Hi ${lead.first_name ?? "there"}, a reminder from ${org.name}: your appointment is ${when}${where}. Reply C to confirm or let me know if you need a new time.`;
}

/** Send a 24h/2h reminder. Inside the send window only; if the window won't open before the appointment, skip. */
export async function sendReminder(db: Db, appointmentId: string, which: "24h" | "2h") {
  const a = await maybeOne<Appointment>(db, "select * from appointments where id = $1", [appointmentId]);
  if (!a || (a.status !== "booked" && a.status !== "confirmed")) return "skipped:status";
  if (which === "24h" ? a.reminder_24h_sent_at : a.reminder_2h_sent_at) return "skipped:sent";
  if (a.starts_at.getTime() <= now().getTime()) return "skipped:past";
  const lead = await one<Lead>(db, "select * from leads where id = $1", [a.lead_id]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [a.org_id]);
  const tz = lead.timezone ?? org.timezone;
  const body = reminderText(which, org, a, lead, tz);
  const sms = await checkSend(db, lead.id, { channel: "sms", automated: true, isReply: false, purpose: "reminder" });
  const channel = sms.ok || (sms.reason === "outside_send_window" && sms.retryAt && sms.retryAt < a.starts_at) ? "sms" : "email";
  if (channel === "sms" && !sms.ok && (!sms.retryAt || sms.retryAt >= a.starts_at)) return "skipped:window";
  const r = await queueOutbound(db, {
    orgId: org.id, leadId: lead.id, channel, body, subject: `Reminder: your appointment with ${org.name}`, author: "system",
    automated: true, isReply: false, purpose: "reminder", ifOutsideWindow: "defer",
  });
  await q(db, `update appointments set ${which === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at"} = $2 where id = $1`, [a.id, now()]);
  return r.status;
}

/** After the appointment ends: ask the rep to mark showed or no-show. */
export async function promptOutcome(db: Db, appointmentId: string) {
  const a = await maybeOne<Appointment>(db, "select * from appointments where id = $1", [appointmentId]);
  if (!a || (a.status !== "booked" && a.status !== "confirmed") || a.outcome_prompted_at) return;
  const lead = await one<Lead>(db, "select * from leads where id = $1", [a.lead_id]);
  const target = a.user_id ?? lead.assigned_user_id;
  if (target) {
    await notifyUser(db, { orgId: a.org_id, userId: target, leadId: lead.id, kind: "appointment_outcome", subject: `Did ${lead.full_name ?? "your appointment"} show?`, body: `Mark showed or no-show: ${leadLink(lead.id)}`, channels: ["in_app", "email"] });
  }
  await q(db, "update appointments set outcome_prompted_at = $2 where id = $1", [a.id, now()]);
}

export async function markAppointment(db: Db, appointmentId: string, status: "showed" | "no_show" | "canceled" | "confirmed", actor: string) {
  const a = await one<Appointment>(db, "update appointments set status = $2 where id = $1 returning *", [appointmentId, status]);
  if (status === "showed") await setStage(db, a.lead_id, "showed", actor);
  if (status === "no_show") {
    // A no-show gets a reschedule message the next morning (lead-local 10:00; compliance re-checks).
    const lead = await one<Lead>(db, "select * from leads where id = $1", [a.lead_id]);
    const org = await one<Org>(db, "select * from organizations where id = $1", [a.org_id]);
    const tz = lead.timezone ?? org.timezone;
    const nextMorning = DateTime.fromJSDate(now(), { zone: tz }).plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    await q(db, "update leads set ai_status = case when ai_status = 'stopped' then ai_status else 'active' end where id = $1", [a.lead_id]);
    await enqueue(db, { orgId: a.org_id, leadId: a.lead_id, kind: "agent_reply", runAt: nextMorning, payload: { trigger: "no_show", appointment_id: a.id }, dedupeKey: `noshow:${a.id}` });
  }
  await q(db, "update jobs set status = 'canceled' where status = 'queued' and payload->>'appointment_id' = $1 and kind in ('reminder', 'appointment_check')", [a.id]).catch(() => {});
  return a;
}

export async function markSold(db: Db, leadId: string, actor: string) {
  await setStage(db, leadId, "sold", actor);
}
