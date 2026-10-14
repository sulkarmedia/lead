"use server";
// Simulator actions. Everyone in the org may use them, but only while DRY_RUN is on; every action
// re-checks that and only touches simulated leads of the caller's current org.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrgContext, audit } from "@/lib/auth";
import { maybeOne, service } from "@/lib/db";
import {
  advanceAndRun, advanceClock, assertDryRun, createSimulatedLead, DAY_MS, drainDue, resetClock, resetSimulatedLeads, SKIP_WAIT_MS, textAsLead,
} from "@/lib/simulator";
import { refreshClock } from "@/worker/index";

async function ctxForSim() {
  assertDryRun();
  const ctx = await getOrgContext();
  await refreshClock();
  return ctx;
}

const done = (leadId?: string | null) => {
  revalidatePath("/simulator");
  revalidatePath("/inbox");
  if (leadId) revalidatePath(`/leads/${leadId}`);
};

export async function createFakeLeadAction(form: FormData) {
  const ctx = await ctxForSim();
  const sourceId = String(form.get("source_id") ?? "");
  const src = await maybeOne<{ id: string }>(service(), "select id from lead_sources where id = $1 and org_id = $2", [sourceId, ctx.org.id]);
  if (!src) throw new Error("Pick a lead source");
  const answers: Record<string, string> = {};
  const model = String(form.get("model") ?? "").trim();
  if (model) answers.which_model = model;
  // Free-form "key: value" lines become form answers.
  for (const line of String(form.get("answers") ?? "").split("\n")) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) answers[m[1].toLowerCase().replace(/\s+/g, "_")] = m[2];
  }
  const r = await createSimulatedLead(service(), ctx.org.id, src.id, {
    name: String(form.get("name") ?? "").trim() || "Sim Lead",
    email: String(form.get("email") ?? "").trim() || null,
    zip: String(form.get("zip") ?? "").trim() || null,
    answers,
  });
  if (r.status === "rejected") throw new Error(`Intake rejected the lead: ${r.reason}`);
  await audit(ctx, "simulator.create_lead", "lead", r.leadId, { status: r.status, source_id: src.id });
  done(r.leadId);
  redirect(`/simulator?lead=${r.leadId}`);
}

export async function textAsLeadAction(form: FormData) {
  const ctx = await ctxForSim();
  const leadId = String(form.get("lead_id"));
  const body = String(form.get("body") ?? "").trim();
  const channel = form.get("channel") === "email" ? "email" : "sms";
  if (!body) return;
  await textAsLead(service(), ctx.org.id, leadId, body, channel);
  if (form.get("skip_wait") === "on") {
    await advanceClock(service(), SKIP_WAIT_MS);
    await drainDue(service());
  }
  done(leadId);
}

/** Drain due jobs; optionally skip the 20s reply debounce first. */
export async function runNowAction(form: FormData) {
  const ctx = await ctxForSim();
  const skip = form.get("skip_wait") === "1";
  if (skip) {
    await advanceClock(service(), SKIP_WAIT_MS);
    await audit(ctx, "simulator.advance_clock", "platform_state", "clock_offset_ms", { ms: SKIP_WAIT_MS });
  }
  await drainDue(service());
  done(String(form.get("lead_id") || "") || null);
}

export async function advanceDayAction(form: FormData) {
  const ctx = await ctxForSim();
  const days = Math.min(Math.max(Number(form.get("days") ?? 1) || 1, 1), 30);
  const r = await advanceAndRun(service(), days * DAY_MS);
  await audit(ctx, "simulator.advance_clock", "platform_state", "clock_offset_ms", { ms: days * DAY_MS, jobs: r.jobs });
  done(String(form.get("lead_id") || "") || null);
}

export async function resetClockAction() {
  const ctx = await ctxForSim();
  await resetClock(service());
  await audit(ctx, "simulator.reset_clock", "platform_state", "clock_offset_ms");
  done();
}

export async function resetSimLeadsAction() {
  const ctx = await ctxForSim();
  if (!ctx.isAdmin) throw new Error("Only owners and admins can reset the simulator");
  const n = await resetSimulatedLeads(service(), ctx.org.id);
  await audit(ctx, "simulator.reset_leads", "organization", ctx.org.id, { deleted: n });
  done();
  redirect("/simulator");
}

