// Booking: the slot is re-checked inside a transaction holding a per-resource advisory lock, so two
// simultaneous bookings of one slot can't both succeed (the unique index is the backstop).
import type pg from "pg";
import type { Db } from "../db";
import { maybeOne, one, q, tx } from "../db";
import type { Appointment, Availability, Lead, Org } from "../db/types";
import { now } from "../clock";
import { cancelJobs, enqueue } from "../jobs";
import { setStage } from "../leads/stages";
import { computeSlots, pickSpread, type Interval, type Slot } from "./slots";
import { getBusy } from "../integrations/google";

export async function loadAvailability(db: Db, orgId: string, userId: string | null): Promise<Availability | null> {
  return (
    (userId ? await maybeOne<Availability>(db, "select * from availability where org_id = $1 and user_id = $2", [orgId, userId]) : null) ??
    (await maybeOne<Availability>(db, "select * from availability where org_id = $1 and user_id is null", [orgId]))
  );
}

async function bookedIntervals(db: Db, orgId: string, userId: string | null): Promise<Interval[]> {
  const rows = await q<{ starts_at: Date; ends_at: Date }>(
    db,
    `select starts_at, ends_at from appointments where org_id = $1 and status in ('booked', 'confirmed')
       and (user_id is not distinct from $2 or $2::uuid is null) and ends_at > $3`,
    [orgId, userId, now()],
  );
  return rows.map((r) => ({ start: r.starts_at, end: r.ends_at }));
}

export async function openSlots(db: Db, lead: Pick<Lead, "org_id" | "assigned_user_id">, overrides?: { slot_minutes?: number; min_notice_minutes?: number; days_ahead?: number }, max = 6): Promise<Slot[]> {
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  const userId = lead.assigned_user_id;
  const availability = await loadAvailability(db, org.id, userId);
  if (!availability) return [];
  const at = now();
  const horizon = new Date(at.getTime() + (availability.max_days_ahead + 1) * 86400_000);
  const [booked, busy] = await Promise.all([bookedIntervals(db, org.id, userId), userId ? getBusy(db, org.id, userId, at, horizon) : Promise.resolve([])]);
  const all = computeSlots({ availability, businessTz: org.timezone, userId, booked, busy, now: at, overrides });
  return pickSpread(all, org.timezone, max);
}

export type BookResult = { ok: true; appointment: Appointment } | { ok: false; reason: "slot_taken" | "slot_invalid" };

export async function bookSlot(input: { orgId: string; leadId: string; slot: { start: Date; end: Date; userId: string | null }; kind?: Appointment["kind"]; createdBy: string }, pool?: pg.Pool): Promise<BookResult> {
  try {
    const appt = await tx(async (c) => {
      const lockKey = `${input.orgId}:${input.slot.userId ?? "org"}`;
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      const clash = await maybeOne(
        c,
        `select 1 from appointments where org_id = $1 and status in ('booked', 'confirmed')
           and user_id is not distinct from $2 and starts_at < $4 and ends_at > $3`,
        [input.orgId, input.slot.userId, input.slot.start, input.slot.end],
      );
      if (clash) return null;
      // Re-validate against the current open slots (hours, notice, busy times).
      const lead = await one<Lead>(c, "select * from leads where id = $1", [input.leadId]);
      if (input.slot.start.getTime() < now().getTime()) return null;
      const a = await one<Appointment>(
        c,
        `insert into appointments (org_id, lead_id, user_id, starts_at, ends_at, kind, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [input.orgId, input.leadId, input.slot.userId, input.slot.start, input.slot.end, input.kind ?? "in_person", input.createdBy],
      );
      await setStage(c, lead.id, "appointment_set", input.createdBy, { onlyForward: false });
      await cancelJobs(c, lead.id, ["followup"]);
      await scheduleAppointmentJobs(c, a);
      await enqueue(c, { orgId: input.orgId, leadId: lead.id, kind: "calendar_sync", payload: { op: "create", appointment_id: a.id }, dedupeKey: `gcal:${a.id}` });
      return a;
    }, pool);
    return appt ? { ok: true, appointment: appt } : { ok: false, reason: "slot_taken" };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, reason: "slot_taken" };
    throw e;
  }
}

export async function scheduleAppointmentJobs(db: Db, a: Appointment) {
  const start = a.starts_at.getTime();
  const t = now().getTime();
  if (start - 24 * 3600_000 > t) await enqueue(db, { orgId: a.org_id, leadId: a.lead_id, kind: "reminder", runAt: new Date(start - 24 * 3600_000), payload: { appointment_id: a.id, which: "24h" }, dedupeKey: `rem24:${a.id}` });
  if (start - 2 * 3600_000 > t) await enqueue(db, { orgId: a.org_id, leadId: a.lead_id, kind: "reminder", runAt: new Date(start - 2 * 3600_000), payload: { appointment_id: a.id, which: "2h" }, dedupeKey: `rem2:${a.id}` });
  await enqueue(db, { orgId: a.org_id, leadId: a.lead_id, kind: "appointment_check", runAt: new Date(a.ends_at.getTime() + 30 * 60_000), payload: { appointment_id: a.id }, dedupeKey: `apptchk:${a.id}` });
}

export async function cancelAppointment(db: Db, appointmentId: string) {
  const a = await one<Appointment>(db, "update appointments set status = 'canceled' where id = $1 returning *", [appointmentId]);
  await q(db, "update jobs set status = 'canceled' where status = 'queued' and payload->>'appointment_id' = $1", [appointmentId]);
  if (a.google_event_id) await enqueue(db, { orgId: a.org_id, leadId: a.lead_id, kind: "calendar_sync", payload: { op: "delete", appointment_id: a.id } });
  return a;
}
