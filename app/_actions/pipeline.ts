"use server";
// Pipeline/calendar actions. Same checks as app/_actions/leads.ts: the lead must be in the current
// org and the user must have edit rights on it (RLS, canEditLead) before anything is written.
import { revalidatePath } from "next/cache";
import { getOrgContext, canEditLead, audit } from "@/lib/auth";
import { maybeOne, service } from "@/lib/db";
import type { Appointment } from "@/lib/db/types";
import { now } from "@/lib/clock";
import { bookSlot, cancelAppointment, openSlots } from "@/lib/booking/book";

/**
 * Reschedule: cancel the old appointment, then book the chosen open slot. Form fields:
 * appointment_id, slot = "<start ISO>|<end ISO>|<user id or empty>".
 * If the new booking fails, the old time is re-booked so the lead is never left without one.
 */
export async function rescheduleAction(form: FormData) {
  const apptId = String(form.get("appointment_id") ?? "");
  const [startIso, endIso, userRaw] = String(form.get("slot") ?? "").split("|");
  const ctx = await getOrgContext();
  const appt = await maybeOne<Appointment>(service(), "select * from appointments where id = $1", [apptId]);
  if (!appt || appt.org_id !== ctx.org.id) throw new Error("Appointment not found");
  if (!(await canEditLead(ctx.user.id, appt.lead_id))) throw new Error("You can only act on leads assigned to you");
  if (appt.status !== "booked" && appt.status !== "confirmed") throw new Error("Only booked appointments can be rescheduled");
  const start = new Date(startIso);
  const end = new Date(endIso);
  const userId = userRaw || null;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error("Pick a time");
  if (start.getTime() <= now().getTime()) throw new Error("That time has passed");
  // The slot must still be one of the open slots for the appointment's rep.
  const open = await openSlots(service(), { org_id: ctx.org.id, assigned_user_id: appt.user_id }, undefined, 100);
  if (!open.some((s) => s.start.getTime() === start.getTime() && s.userId === userId)) throw new Error("That time is no longer available");

  const actor = `user:${ctx.user.email ?? ctx.user.id}`;
  await cancelAppointment(service(), appt.id);
  const r = await bookSlot({ orgId: ctx.org.id, leadId: appt.lead_id, slot: { start, end, userId }, kind: appt.kind, createdBy: actor });
  if (!r.ok) {
    if (appt.starts_at.getTime() > now().getTime()) {
      await bookSlot({ orgId: ctx.org.id, leadId: appt.lead_id, slot: { start: appt.starts_at, end: appt.ends_at, userId: appt.user_id }, kind: appt.kind, createdBy: actor });
    }
    throw new Error("That time is no longer available");
  }
  await audit(ctx, "reschedule", "appointment", appt.id, { from: appt.starts_at, to: start, new_appointment_id: r.appointment.id });
  revalidatePath("/calendar");
  revalidatePath("/leads");
  revalidatePath(`/leads/${appt.lead_id}`);
}
