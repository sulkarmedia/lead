// runAgent(leadId, trigger): build context, call Claude once (plus one regenerate if the SMS is too
// long), validate, run guards, and record an ai_runs row. It never sends anything.
import type { Db } from "../db";
import { one, q } from "../db";
import { now } from "../clock";
import { buildContext, type AgentContext, type AgentTrigger } from "./context";
import { runGuards, type GuardResult } from "./guards";
import { getModel, type ModelUsage } from "./model";
import { PROMPT_VERSION } from "./prompt";
import type { AgentOutput } from "./schema";

export interface AgentRun {
  runId: string;
  ctx: AgentContext;
  output: AgentOutput | null;
  guard: GuardResult | null;
  /** "unavailable": nothing was sent, the job should retry. "agent_error": two schema failures in a row. */
  error: null | "unavailable" | "schema" | "agent_error" | "refusal";
  errorMessage?: string;
}

export async function runAgent(db: Db, leadId: string, trigger: AgentTrigger, opts: { timeoutMs?: number } = {}): Promise<AgentRun> {
  const ctx = await buildContext(db, leadId, trigger);
  const model = getModel();
  let res = await model.generate(ctx.request, { timeoutMs: opts.timeoutMs });
  const usages: ModelUsage[] = [];
  if (res.usage) usages.push(res.usage);

  let output: AgentOutput | null = null;
  let guard: GuardResult | null = null;
  let error: AgentRun["error"] = null;
  let errorMessage: string | undefined;

  const lastInbound = [...ctx.messages].reverse().find((m) => m.author === "lead");
  const unanswered = ctx.messages
    .filter((m) => m.author === "ai" && m.direction === "outbound" && (m.status === "sent" || m.status === "delivered") && (!lastInbound || m.created_at > lastInbound.created_at))
    .map((m) => m.sent_at ?? m.created_at);
  const guardCtx = {
    trigger: trigger.kind,
    businessName: ctx.org.name,
    knowledgeText: ctx.knowledge.map((k) => `${k.title}\n${k.body}`).join("\n"),
    neverSay: ctx.playbook.never_say ?? [],
    offeredSlotIds: ctx.slots.map((s) => s.id),
    unansweredAiMessages: unanswered,
    now: now(),
    isFirstMessage: ctx.isFirstMessage,
  };

  if (res.ok) {
    output = res.output;
    guard = runGuards(output, guardCtx);
    if (!guard.ok && guard.failures.includes("sms_too_long")) {
      const retry = await model.generate(
        { ...ctx.request, retryNote: `Your SMS was ${output.message?.body.length} characters. Rewrite it under 300 characters, keeping one question.` },
        { timeoutMs: opts.timeoutMs },
      );
      if (retry.usage) usages.push(retry.usage);
      if (retry.ok) {
        output = retry.output;
        guard = runGuards(output, guardCtx);
      }
    }
    await q(db, "update leads set schema_failure_streak = 0 where id = $1", [leadId]);
  } else if (res.kind === "schema") {
    const { schema_failure_streak } = await one<{ schema_failure_streak: number }>(
      db, "update leads set schema_failure_streak = schema_failure_streak + 1 where id = $1 returning schema_failure_streak", [leadId]);
    error = schema_failure_streak >= 2 ? "agent_error" : "schema";
    errorMessage = res.error;
  } else {
    error = res.kind === "refusal" ? "refusal" : "unavailable";
    errorMessage = res.error;
  }

  const total = usages.reduce((a, u) => ({ tokensIn: a.tokensIn + u.tokensIn, tokensOut: a.tokensOut + u.tokensOut, cacheRead: a.cacheRead + u.cacheRead, latencyMs: a.latencyMs + u.latencyMs }), { tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 });
  const run = await one<{ id: string }>(
    db,
    `insert into ai_runs (org_id, lead_id, trigger, model, prompt_version, output, guard_result, error, tokens_in, tokens_out, cache_read_tokens, latency_ms, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      ctx.org.id, leadId, trigger.kind, usages[0]?.model ?? "unknown", PROMPT_VERSION, output ? JSON.stringify(output) : null,
      JSON.stringify({ ...(guard ?? {}), offered_slots: ctx.slots.map((s) => ({ id: s.id, start: s.start, end: s.end, user_id: s.userId })) }),
      errorMessage ? `${error}: ${errorMessage}`.slice(0, 2000) : null, total.tokensIn, total.tokensOut, total.cacheRead, total.latencyMs, now(),
    ],
  );
  return { runId: run.id, ctx, output, guard, error, errorMessage };
}
