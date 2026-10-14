"use server";
// Rep actions. Every action checks org membership and edit rights through RLS (canEditLead) before
// calling the pipeline, which re-applies compliance on every send.
import { revalidatePath } from "next/cache";
import { getOrgContext, canEditLead, audit } from "@/lib/auth";
import { maybeOne, q, service } from "@/lib/db";
import type { LeadStage } from "@/lib/db/types";
import { STAGES } from "@/lib/db/types";
import { sendAsRep, handBackToAi, setAiStatus } from "@/lib/inbox";
import { approveMessage, deliverMessage, rejectMessage } from "@/lib/messaging/send";
import { setStage } from "@/lib/leads/stages";
import { markAppointment, markSold } from "@/lib/appointments";
import { cancelAppointment, bookSlot } from "@/lib/booking/book";

async function guardLead(leadId: string) {
  const ctx = await getOrgContext();
  const lead = await maybeOne<{ org_id: string }>(service(), "select org_id from leads where id = $1", [leadId]);
  if (!lead || lead.org_id !== ctx.org.id) throw new Error("Lead not found");
  if (!(await canEditLead(ctx.user.id, leadId))) throw new Error("You can only act on leads assigned to you");
  return ctx;
}

const done = (leadId?: string) => {
  revalidatePath("/inbox");
  revalidatePath("/leads");
  if (leadId) revalidatePath(`/leads/${leadId}`);
};

export async function sendMessageAction(form: FormData) {
  const leadId = String(form.get("lead_id"));
  const ctx = await guardLead(leadId);
  const body = String(form.get("body") ?? "").trim();
  const channel = String(form.get("channel") ?? "sms") as "sms" | "email" | "note";
  if (!body) return;
  await sendAsRep(service(), { leadId, userId: ctx.user.id, channel, body, subject: (form.get("subject") as string) || null });
  done(leadId);
}

export async function approveAction(form: FormData) {
  const messageId = String(form.get("message_id"));
  const m = await maybeOne<{ lead_id: string }>(service(), "select lead_id from messages where id = $1", [messageId]);
  if (!m) return;
  const ctx = await guardLead(m.lead_id);
  const edited = form.get("body") ? String(form.get("body")) : undefined;
  await approveMessage(service(), messageId, ctx.user.id, edited);
  done(m.lead_id);
}

export async function rejectAction(form: FormData) {
  const messageId = String(form.get("message_id"));
  const m = await maybeOne<{ lead_id: string }>(service(), "select lead_id from messages where id = $1", [messageId]);
  if (!m) return;
  await guardLead(m.lead_id);
  await rejectMessage(service(), messageId);
  done(m.lead_id);
}

export async function retryAction(form: FormData) {
  const messageId = String(form.get("message_id"));
  const m = await maybeOne<{ lead_id: string }>(service(), "select lead_id from messages where id = $1 and status = 'failed'", [messageId]);
  if (!m) return;
  await guardLead(m.lead_id);
  await q(service(), "update messages set status = 'queued', error = null where id = $1", [messageId]);
  await deliverMessage(service(), messageId);
  done(m.lead_id);
}

export async function aiControlAction(form: FormData) {
  const leadId = String(form.get("lead_id"));
  const ctx = await guardLead(leadId);
  const op = String(form.get("op"));
  if (op === "hand_back") await handBackToAi(service(), leadId, ctx.user.id);
  else if (op === "pause" || op === "stop" || op === "resume") await setAiStatus(service(), leadId, ctx.user.id, op === "resume" ? "active" : op === "pause" ? "paused" : "stopped");
  done(leadId);
}

export async function moveStageAction(leadId: string, stage: LeadStage) {
  const ctx = await guardLead(leadId);
  if (!STAGES.includes(stage)) throw new Error("bad stage");
  await setStage(service(), leadId, stage, `user:${ctx.user.email ?? ctx.user.id}`);
  done(leadId);
}

export async function moveStageFormAction(form: FormData) {
  await moveStageAction(String(form.get("lead_id")), String(form.get("stage")) as LeadStage);
}

export async function assignAction(form: FormData) {
  const leadId = String(form.get("lead_id"));
  const ctx = await guardLead(leadId);
  const userId = String(form.get("user_id") || "") || null;
  if (userId && !(await maybeOne(service(), "select 1 from memberships where org_id = $1 and user_id = $2 and active", [ctx.org.id, userId]))) throw new Error("not a member");
  await q(service(), "update leads set assigned_user_id = $2 where id = $1", [leadId, userId]);
  await audit(ctx, "assign", "lead", leadId, { assigned_user_id: userId });
  done(leadId);
}

export async function appointmentAction(form: FormData) {
  const apptId = String(form.get("appointment_id"));
  const a = await maybeOne<{ lead_id: string }>(service(), "select lead_id from appointments where id = $1", [apptId]);
  if (!a) return;
  const ctx = await guardLead(a.lead_id);
  const op = String(form.get("op"));
  if (op === "canceled") await cancelAppointment(service(), apptId);
  else if (op === "sold") await markSold(service(), a.lead_id, `user:${ctx.user.email}`);
  else await markAppointment(service(), apptId, op as "showed" | "no_show" | "confirmed", `user:${ctx.user.email}`);
  done(a.lead_id);
  revalidatePath("/calendar");
}

export async function bookManualAction(form: FormData) {
  const leadId = String(form.get("lead_id"));
  const ctx = await guardLead(leadId);
  const start = new Date(String(form.get("starts_at")));
  const minutes = Number(form.get("minutes") ?? 45);
  const userId = (form.get("user_id") as string) || null;
  const r = await bookSlot({ orgId: ctx.org.id, leadId, slot: { start, end: new Date(start.getTime() + minutes * 60_000), userId }, kind: (form.get("kind") as "in_person" | "call") ?? "in_person", createdBy: `user:${ctx.user.email}` });
  if (!r.ok) throw new Error("That time is no longer available");
  done(leadId);
  revalidatePath("/calendar");
}

export async function deleteLeadDataAction(form: FormData) {
  const leadId = String(form.get("lead_id"));
  const ctx = await guardLead(leadId);
  if (!ctx.isAdmin) throw new Error("Only owners and admins can delete lead data");
  if (form.get("confirm") !== "yes") throw new Error("Confirm the deletion first");
  const { deleteLeadData } = await import("@/lib/leads/delete");
  await deleteLeadData(service(), leadId, `user:${ctx.user.email ?? ctx.user.id}`);
  done(leadId);
}
