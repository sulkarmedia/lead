// The conversation engine: inbound messages, opt-outs, first touch, replies, follow-ups.
// The agent proposes; this file decides what is actually sent.
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { Lead, Message, Org, Playbook } from "./db/types";
import { now } from "./clock";
import { enqueue, cancelJobs } from "./jobs";
import { log } from "./log";
import { checkSend } from "./compliance";
import { detectOptOut, mightBeOptOut, OPT_OUT_CONFIRMATION_SMS } from "./compliance/optOut";
import { queueOutbound } from "./messaging/send";
import { runAgent, type AgentRun } from "./agent/run";
import { loadPlaybook, renderIntroTemplate, type AgentTrigger } from "./agent/context";
import { extractedToRecord } from "./agent/schema";
import { getModel } from "./agent/model";
import { setStage, enqueueWebhook } from "./leads/stages";
import { handoff } from "./handoff";
import { restartAsWentQuiet, scheduleNextFollowup, stepsFor, NURTURE_MONTHS, cadenceShouldStop, stopCadence } from "./cadence";
import { bookSlot } from "./booking/book";
import { formatSlot } from "./booking/slots";
import { leadLink, notifyUser } from "./notify";

export const REPLY_DEBOUNCE_MS = 20_000;
export const FIRST_TOUCH_MODEL_BUDGET_MS = 45_000;
const LOW_CONFIDENCE = 0.5;

/** Thrown when the job should be retried later (model unavailable). */
export class RetryLater extends Error {}

// ---------------------------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------------------------

export interface InboundInput {
  orgId: string;
  leadId: string;
  channel: "sms" | "email";
  body: string;
  subject?: string | null;
  providerMessageId?: string | null;
  from?: string | null;
  /** Twilio Advanced Opt-Out already handled a keyword and sent its own confirmation. */
  carrierHandledOptOut?: "STOP" | "START" | "HELP" | null;
}

export async function handleInbound(db: Db, i: InboundInput): Promise<{ messageId: string; action: string }> {
  if (i.providerMessageId) {
    const dup = await maybeOne<{ id: string }>(db, "select id from messages where provider_message_id = $1", [i.providerMessageId]);
    if (dup) return { messageId: dup.id, action: "duplicate" };
  }
  const at = now();
  const msg = await one<{ id: string }>(
    db,
    `insert into messages (org_id, lead_id, channel, direction, author, body, subject, status, provider_message_id, from_address, created_at)
     values ($1, $2, $3, 'inbound', 'lead', $4, $5, 'received', $6, $7, $8) returning id`,
    [i.orgId, i.leadId, i.channel, i.body, i.subject ?? null, i.providerMessageId ?? null, i.from ?? null, at],
  );
  await q(db, "update leads set last_inbound_at = $2 where id = $1", [i.leadId, at]);
  const lead = await one<Lead>(db, "select * from leads where id = $1", [i.leadId]);

  // 1. Opt-out check first, always.
  const opt = await detectOptOutWithClassifier(i.body, i.channel);
  if (opt.optIn && i.channel === "sms") {
    await q(db, "update leads set opted_out_sms_at = null, ai_status = case when ai_status = 'stopped' then 'paused' else ai_status end, ai_paused_reason = case when ai_status = 'stopped' then 'resubscribed: rep to decide' else ai_paused_reason end where id = $1", [i.leadId]);
    await systemNote(db, lead, "Lead texted START: SMS re-enabled. AI is paused until a rep hands the thread back.");
    return { messageId: msg.id, action: "opt_in" };
  }
  if (opt.optOut) {
    await applyOptOut(db, lead, opt.scope ?? "sms", opt.reason ?? "keyword", { viaChannel: i.channel, carrierConfirmed: i.carrierHandledOptOut === "STOP" });
    return { messageId: msg.id, action: "opt_out" };
  }

  // The lead replied: stage engaged, cadence restarts as "went quiet" after this exchange.
  await setStage(db, lead.id, "engaged", "lead_reply", { onlyForward: true });
  await cancelJobs(db, lead.id, ["followup"]);

  // 2. A human owns the thread: notify the assigned rep and do nothing else.
  if (lead.ai_status === "paused") {
    const target = lead.assigned_user_id;
    if (target) {
      await notifyUser(db, { orgId: lead.org_id, userId: target, leadId: lead.id, kind: "paused_reply", subject: `New reply from ${lead.full_name ?? "a lead"}`, body: `${i.body.slice(0, 200)}\n${leadLink(lead.id)}`, channels: ["in_app", "sms"] });
    }
    return { messageId: msg.id, action: "notified_rep" };
  }
  if (lead.ai_status === "stopped") return { messageId: msg.id, action: "ai_stopped" };

  // 3. Wait for more messages (people send in bursts), then run the agent on the full thread.
  const key = `reply:${lead.id}`;
  const runAt = new Date(at.getTime() + REPLY_DEBOUNCE_MS);
  const bumped = await q(db, "update jobs set run_at = $2 where dedupe_key = $1 and status = 'queued' returning id", [key, runAt]);
  if (bumped.length === 0) await enqueue(db, { orgId: lead.org_id, leadId: lead.id, kind: "agent_reply", runAt, dedupeKey: key });
  return { messageId: msg.id, action: "agent_scheduled" };
}

async function detectOptOutWithClassifier(body: string, channel: "sms" | "email") {
  const rule = detectOptOut(body);
  if (rule.optOut || rule.optIn) return rule;
  if (!mightBeOptOut(body)) return rule;
  try {
    const r = await getModel().classifyOptOut(body);
    if (r.ok && r.output.opt_out && r.output.confidence >= 0.6) {
      return { optOut: true, scope: r.output.scope === "all" ? ("all" as const) : ("sms" as const), reason: r.output.wrong_number ? ("wrong_number" as const) : ("classifier" as const) };
    }
  } catch (e) {
    log.warn("classifier.failed", { error: (e as Error).message, channel });
  }
  return rule;
}

export async function applyOptOut(db: Db, lead: Lead, scope: "sms" | "all", reason: string, opts: { viaChannel: "sms" | "email" | "web"; carrierConfirmed?: boolean }) {
  const at = now();
  const smsOut = scope === "all" || opts.viaChannel !== "email";
  const emailOut = scope === "all" || opts.viaChannel === "email";
  const alreadyOut = (!smsOut || !!lead.opted_out_sms_at) && (!emailOut || !!lead.opted_out_email_at);
  const smsLeft = !smsOut && !!lead.phone_e164 && !lead.opted_out_sms_at;
  const emailLeft = !emailOut && !!lead.email && !lead.opted_out_email_at;
  const stopAi = reason === "wrong_number" || (!smsLeft && !emailLeft);
  await q(
    db,
    `update leads set opted_out_sms_at = case when $2 then coalesce(opted_out_sms_at, $4) else opted_out_sms_at end,
                      opted_out_email_at = case when $3 then coalesce(opted_out_email_at, $4) else opted_out_email_at end,
                      ai_status = case when $5 then 'stopped'::ai_status else ai_status end,
                      ai_paused_reason = case when $5 then 'opted_out' else ai_paused_reason end
      where id = $1`,
    [lead.id, smsOut, emailOut, at, stopAi],
  );
  // Nothing automated may follow: cancel everything queued for this lead and hold unsent messages.
  await cancelJobs(db, lead.id, ["first_touch", "followup", "agent_reply", "scheduled_send", "handoff_sla"]);
  await q(db, `update messages set status = 'blocked', blocked_reason = 'opted_out' where lead_id = $1 and direction = 'outbound' and status in ('queued', 'pending_approval')
                 and ((channel = 'sms' and $2) or (channel = 'email' and $3))`, [lead.id, smsOut, emailOut]);
  if (!stopAi) await scheduleNextFollowup(db, lead.id); // the remaining channel's cadence continues
  await systemNote(db, lead, `Opted out (${scope === "all" ? "all channels" : "SMS"}; ${reason}).`);
  await enqueueWebhook(db, lead.org_id, lead.id, "lead.opted_out", { scope, reason });
  if (reason === "wrong_number") await setStage(db, lead.id, "lost", "wrong_number");

  // One confirmation text, then silence. Twilio Advanced Opt-Out already confirms carrier keywords.
  if (opts.viaChannel === "sms" && !opts.carrierConfirmed && !alreadyOut) {
    const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
    await queueOutbound(db, {
      orgId: lead.org_id, leadId: lead.id, channel: "sms", body: OPT_OUT_CONFIRMATION_SMS(org.name), author: "system",
      automated: true, isReply: true, purpose: "opt_out_confirmation", ifOutsideWindow: "block",
    });
  }
}

async function systemNote(db: Db, lead: Pick<Lead, "id" | "org_id">, body: string) {
  await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, status, purpose, created_at) values ($1, $2, 'system', 'internal', 'system', $3, 'received', 'note', $4)`, [lead.org_id, lead.id, body, now()]);
}

// ---------------------------------------------------------------------------------------------
// First touch
// ---------------------------------------------------------------------------------------------

export async function firstTouch(db: Db, leadId: string): Promise<{ sms?: string; email?: string }> {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (lead.ai_status !== "active" || lead.split_arm === "control" || lead.deleted_at) return {};
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  const pb = await loadPlaybook(db, lead);
  const smsCheck = await checkSend(db, leadId, { channel: "sms", automated: true, isReply: false });
  const emailCheck = await checkSend(db, leadId, { channel: "email", automated: true, isReply: false });
  const smsPossible = smsCheck.ok || smsCheck.reason === "outside_send_window";
  const out: { sms?: string; email?: string } = {};

  if (smsPossible) {
    const body = await composeFirstTouch(db, lead, org, pb, "sms");
    const r = await queueOutbound(db, {
      orgId: org.id, leadId, channel: "sms", body: body.text, author: body.aiRunId ? "ai" : "system", automated: true, isReply: false,
      purpose: "first_touch", aiRunId: body.aiRunId, guardResult: body.guard, requireApproval: pb.approve_before_send, ifOutsideWindow: "defer",
    });
    out.sms = r.status;
  }
  if (emailCheck.ok) {
    const body = await composeFirstTouch(db, lead, org, pb, "email");
    const r = await queueOutbound(db, {
      orgId: org.id, leadId, channel: "email", subject: body.subject ?? `Thanks for reaching out to ${org.name}`, body: body.text,
      author: body.aiRunId ? "ai" : "system", automated: true, isReply: false, purpose: "first_touch", aiRunId: body.aiRunId, guardResult: body.guard,
      requireApproval: pb.approve_before_send,
    });
    out.email = r.status;
  }
  if (!smsPossible && !emailCheck.ok) {
    await systemNote(db, lead, `No first touch possible (SMS: ${smsCheck.reason}; email: ${emailCheck.reason}). A rep should follow up manually.`);
  }
  await scheduleNextFollowup(db, leadId);
  return out;
}

/** Agent-written intro, or the playbook's fixed template if the model fails, is slow (45s) or a guard trips. */
async function composeFirstTouch(db: Db, lead: Lead, org: Org, pb: Playbook, channel: "sms" | "email"): Promise<{ text: string; subject?: string | null; aiRunId: string | null; guard: unknown }> {
  const template = renderIntroTemplate(pb.intro_template, org, lead);
  const fallbackEmail = template.replace(/\s*Reply STOP to opt out\.?/i, "");
  let run: AgentRun | null = null;
  try {
    run = await withTimeout(runAgent(db, lead.id, { kind: "first_touch", channel }, { timeoutMs: 20_000 }), FIRST_TOUCH_MODEL_BUDGET_MS);
  } catch (e) {
    log.warn("first_touch.model_fallback", { org_id: org.id, lead_id: lead.id, error: (e as Error).message });
  }
  const o = run?.output;
  if (run && o && run.guard?.ok && o.message?.body && (o.action === "reply" || o.action === "handoff")) {
    let text = o.message.body.trim();
    if (channel === "sms" && !/reply stop/i.test(text)) {
      const withStop = `${text} Reply STOP to opt out.`;
      text = withStop.length <= 320 ? withStop : text;
    }
    await applyExtraction(db, lead, run);
    return { text, subject: o.message.subject, aiRunId: run.runId, guard: run.guard };
  }
  return { text: channel === "sms" ? template : fallbackEmail, subject: null, aiRunId: run?.runId ?? null, guard: { fallback: "intro_template", agent_guard: run?.guard ?? null, agent_error: run?.error ?? "timeout" } };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------------------------
// Replies and follow-ups
// ---------------------------------------------------------------------------------------------

export async function agentReply(db: Db, leadId: string, payload: { trigger?: string } = {}) {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (lead.ai_status !== "active" || lead.deleted_at) return;
  if (payload.trigger === "no_show" || payload.trigger === "resume") {
    const trigger: AgentTrigger = payload.trigger === "no_show" ? { kind: "no_show" } : { kind: "resume", reason: "no rep reply within the SLA" };
    const run = await runAgent(db, leadId, trigger);
    await applyAgentRun(db, lead, run, trigger);
    if (lead.ai_status === "active") await scheduleNextFollowup(db, leadId);
    return;
  }
  // Nothing new to answer (e.g. the debounce fired after a rep already replied).
  const last = await maybeOne<Message>(db, "select * from messages where lead_id = $1 and channel in ('sms', 'email') order by created_at desc limit 1", [leadId]);
  if (!last || last.author !== "lead") return;
  const run = await runAgent(db, leadId, { kind: "reply" });
  await applyAgentRun(db, lead, run, { kind: "reply" });
}

export async function followup(db: Db, leadId: string, payload: { step: number; kind: string }) {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (lead.cadence_step !== payload.step || lead.cadence_kind !== payload.kind) return; // stale job
  const pb = await loadPlaybook(db, lead);
  const stop = cadenceShouldStop(lead, pb.max_touches);
  if (stop) return;
  const steps = stepsFor(pb, lead.cadence_kind);
  const step = steps[payload.step];
  if (!step) return;
  const baseLen = steps.length - NURTURE_MONTHS;
  if (payload.step >= baseLen) await setStage(db, leadId, "nurture", "cadence");

  const sms = step.channel !== "email" && (await canAutoSms(db, leadId));
  const email = (step.channel !== "sms" || !sms) && !!lead.email && !lead.opted_out_email_at;
  for (const channel of [sms && "sms", email && "email"].filter(Boolean) as Array<"sms" | "email">) {
    const run = await runAgent(db, leadId, { kind: "followup", step: payload.step, totalSteps: steps.length, angle: step.angle, channel });
    if (run.error === "unavailable") throw new RetryLater(run.errorMessage ?? "model unavailable");
    await applyAgentRun(db, lead, run, { kind: "followup", step: payload.step, totalSteps: steps.length, angle: step.angle, channel }, { channel });
  }
  const after = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (after.ai_status === "active" && after.cadence_step === payload.step) {
    await q(db, "update leads set cadence_step = cadence_step + 1 where id = $1", [leadId]);
    await scheduleNextFollowup(db, leadId);
  }
}

async function canAutoSms(db: Db, leadId: string) {
  const c = await checkSend(db, leadId, { channel: "sms", automated: true, isReply: false });
  return c.ok || c.reason === "outside_send_window" || c.reason === "frequency_cap";
}

async function applyExtraction(db: Db, lead: Lead, run: AgentRun) {
  const o = run.output;
  if (!o) return;
  const pb = run.ctx.playbook;
  const fields = Object.keys(pb.qualification_fields);
  const extracted = extractedToRecord(o, fields);
  const qual = { ...(lead.qualification ?? {}), ...extracted };
  const filled = fields.filter((f) => qual[f]).length;
  const score = Math.min(100, Math.round((fields.length ? (filled / fields.length) * 50 : 0) + (o.warm ? 30 : 0) + (lead.last_inbound_at ? 20 : 0)));
  await q(db, "update leads set qualification = $2, warm = warm or $3, score = $4, summary = $5 where id = $1", [lead.id, JSON.stringify(qual), o.warm, score, o.summary || lead.summary]);
}

/**
 * Plain code decides what happens with the agent's proposal: guards, approval queue, booking,
 * handoff, stop, stage, cadence.
 */
export async function applyAgentRun(db: Db, lead: Lead, run: AgentRun, trigger: AgentTrigger, opts: { channel?: "sms" | "email" } = {}) {
  const isReply = trigger.kind === "reply";
  if (run.error === "unavailable") throw new RetryLater(run.errorMessage ?? "model unavailable");
  if (run.error === "schema") throw new RetryLater("agent schema failure");
  if (run.error === "agent_error" || run.error === "refusal") {
    await handoff(db, lead.id, run.error === "refusal" ? "agent_refusal" : "agent_error");
    return;
  }
  const o = run.output!;
  const pb = run.ctx.playbook;
  await applyExtraction(db, lead, run);

  // Low confidence twice in a row → handoff.
  const { low_confidence_streak } = await one<{ low_confidence_streak: number }>(
    db, "update leads set low_confidence_streak = case when $2 then low_confidence_streak + 1 else 0 end where id = $1 returning low_confidence_streak", [lead.id, o.confidence < LOW_CONFIDENCE]);

  // The agent recognised an opt-out the rules missed: the rule wins, stop texting.
  if ((o.intent === "opt_out" || o.intent === "wrong_number") && isReply) {
    await applyOptOut(db, lead, "sms", o.intent === "wrong_number" ? "wrong_number" : "classifier", { viaChannel: "sms" });
    return;
  }

  const channel = o.message?.channel ?? opts.channel ?? "sms";
  const base = { orgId: lead.org_id, leadId: lead.id, author: "ai" as const, automated: true, isReply, aiRunId: run.runId, guardResult: run.guard, requireApproval: pb.approve_before_send };
  const recordBlocked = async (reason: string) => {
    if (!o.message?.body) return;
    await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, subject, status, blocked_reason, ai_run_id, guard_result, is_automated, is_reply, purpose, created_at)
                 values ($1, $2, $3, 'outbound', 'ai', $4, $5, 'blocked', $6, $7, $8, true, $9, $10, $11)`,
      [lead.org_id, lead.id, channel, o.message.body, o.message.subject, reason, run.runId, JSON.stringify({ guards: run.guard }), isReply, trigger.kind, now()]);
  };

  if (run.guard && !run.guard.ok) {
    await recordBlocked(run.guard.failures.join(","));
    if (run.guard.handoff || o.action === "handoff") await doHandoff(db, lead, pb, run, run.guard.failures.join(","), channel, isReply);
    else if (low_confidence_streak >= 2) await doHandoff(db, lead, pb, run, "low_confidence", channel, isReply);
    else if (isReply) await restartAsWentQuiet(db, lead.id);
    return;
  }

  switch (o.action) {
    case "reply":
      if (o.message?.body) await queueOutbound(db, { ...base, channel, body: o.message.body, subject: o.message.subject, purpose: isReply ? "reply" : trigger.kind });
      break;
    case "no_reply":
      break;
    case "handoff":
      await doHandoff(db, lead, pb, run, o.handoff_reason ?? o.intent, channel, isReply);
      return;
    case "book": {
      const offered = run.ctx.slots.find((s) => s.id === o.book_slot_id);
      if (!offered) {
        await doHandoff(db, lead, pb, run, "book_slot_not_offered", channel, isReply);
        return;
      }
      const res = await bookSlot({ orgId: lead.org_id, leadId: lead.id, slot: offered, kind: pb.booking?.kinds?.includes("call") && /call|phone/i.test(o.message?.body ?? "") ? "call" : "in_person", createdBy: "ai" });
      const tz = lead.timezone ?? run.ctx.org.timezone;
      if (res.ok) {
        const addr = run.ctx.org.address ? ` We're at ${run.ctx.org.address}.` : "";
        const body = o.message?.body?.trim() || `You're booked for ${formatSlot(offered, tz)}.`;
        const withAddr = run.ctx.org.address && !body.includes(run.ctx.org.address.split(",")[0]) && (body + addr).length <= 320 ? body + addr : body;
        // Booking confirmations go out right away even under approve-before-send: the slot is already held.
        await queueOutbound(db, { ...base, requireApproval: false, channel, body: withAddr, subject: o.message?.subject ?? "Your appointment is confirmed", purpose: "confirmation" });
      } else {
        const fresh = run.ctx.slots.filter((s) => s.id !== offered.id).slice(0, 2);
        const body = fresh.length === 2
          ? `Sorry, that time was just taken. Would ${formatSlot(fresh[0], tz)} or ${formatSlot(fresh[1], tz)} work instead?`
          : "Sorry, that time was just taken. I'll have a member of our team reach out to find another time.";
        await queueOutbound(db, { ...base, requireApproval: false, channel, body, purpose: "reply" });
        if (fresh.length < 2) await handoff(db, lead.id, "slot_taken", { summary: o.summary });
      }
      return;
    }
    case "stop":
      await q(db, "update leads set ai_status = 'stopped', ai_paused_reason = $2 where id = $1", [lead.id, `agent_stop: ${o.intent}`]);
      await stopCadence(db, lead.id);
      if (o.message?.body && (o.intent === "not_interested" || o.intent === "bought_elsewhere")) {
        await queueOutbound(db, { ...base, channel, body: o.message.body, purpose: "closing", requireApproval: pb.approve_before_send });
      }
      await setStage(db, lead.id, "lost", "ai");
      return;
  }

  // Stage suggestions: forward moves only (plus nurture/lost exits).
  if (o.stage_suggestion === "nurture" || o.stage_suggestion === "lost") await setStage(db, lead.id, o.stage_suggestion, "ai");
  else if (o.stage_suggestion === "engaged" || o.stage_suggestion === "qualified") await setStage(db, lead.id, o.stage_suggestion, "ai", { onlyForward: true });

  // Warm rule met → qualified; hand off if the playbook lists the warm rule as a trigger.
  if (o.warm) {
    await setStage(db, lead.id, "qualified", "ai", { onlyForward: true });
    const handoffOnWarm = (pb.handoff_triggers ?? []).some((t) => /warm/i.test(t));
    if (handoffOnWarm) {
      await doHandoff(db, lead, pb, run, "warm", channel, isReply);
      return;
    }
  }
  if (low_confidence_streak >= 2) {
    await doHandoff(db, lead, pb, run, "low_confidence", channel, isReply);
    return;
  }
  if (isReply) await restartAsWentQuiet(db, lead.id);
}

async function doHandoff(db: Db, lead: Lead, pb: Playbook, run: AgentRun, reason: string, channel: "sms" | "email", isReply: boolean) {
  // Bridge message: code-written so a blocked agent message can never leak through it.
  if (pb.bridge_message_allowed) {
    const rep = run.ctx.repName?.split(" ")[0];
    const body = rep ? `Thanks! I'm looping in ${rep}, who'll reply to you here shortly.` : "Thanks! I'm looping in a member of our team, who'll reply to you here shortly.";
    const agentBridge = run.output?.action === "handoff" && run.guard?.ok ? run.output.message?.body : null;
    await queueOutbound(db, { orgId: lead.org_id, leadId: lead.id, channel, body: agentBridge || body, author: "ai", automated: true, isReply, purpose: "bridge", aiRunId: run.runId, guardResult: run.guard, requireApproval: false });
  }
  if (/warm/.test(reason) || run.output?.warm) await setStage(db, lead.id, "qualified", "ai", { onlyForward: true });
  await handoff(db, lead.id, reason, { summary: run.output?.summary });
}
