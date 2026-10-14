// Simulator support (dry-run only): fake leads, texting as the lead, and a simulation clock.
// The clock offset lives in platform_state 'clock_offset_ms'; lib/clock.ts honours it only in dry-run
// and the worker re-reads it every loop. Tests freeze the clock instead; advanceClock moves that too.
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import { advance, getOffsetMs, now } from "./clock";
import { env } from "./env";
import { ingestLead, type IntakeResult } from "./leads/intake";
import { handleInbound } from "./conversation";
import { refreshClock, tick } from "../worker/index";
import { runFirstTouchNow } from "../worker/fastpath";

export const SIM_MARK = "simulated";
export const HOUR_MS = 3600_000;
export const DAY_MS = 86400_000;
/** Skipping the reply debounce (20s) with a little margin. */
export const SKIP_WAIT_MS = 25_000;

/** SQL predicate (alias `l`) for a simulated lead. */
export const SIMULATED_SQL = `(l.answers->>'${SIM_MARK}' = 'true' or exists (select 1 from lead_sources s where s.id = l.source_id and s.name = 'Simulator'))`;

export function assertDryRun() {
  if (!env.dryRun) throw new Error("The simulator only works while DRY_RUN is on.");
}

async function readOffset(db: Db): Promise<number> {
  const row = await maybeOne<{ value: { ms?: number } }>(db, "select value from platform_state where key = 'clock_offset_ms'");
  return Number(row?.value?.ms ?? 0) || 0;
}

async function writeOffset(db: Db, ms: number) {
  await q(db, `insert into platform_state (key, value, updated_at) values ('clock_offset_ms', $1, $2)
               on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify({ ms }), now()]);
}

/** True when tests froze the clock (setNow). Probing with advance(0) is side-effect free. */
function clockIsFrozen(): boolean {
  try {
    advance(0);
    return true;
  } catch {
    return false;
  }
}

/** Move simulated time forward by `ms`. Frozen (test) clock: move it directly. Otherwise persist the offset. */
export async function advanceClock(db: Db, ms: number): Promise<{ offsetMs: number; frozen: boolean }> {
  assertDryRun();
  if (ms <= 0) return { offsetMs: getOffsetMs(), frozen: clockIsFrozen() };
  if (clockIsFrozen()) {
    advance(ms);
    return { offsetMs: getOffsetMs(), frozen: true };
  }
  const next = (await readOffset(db)) + ms;
  await writeOffset(db, next);
  await refreshClock();
  return { offsetMs: next, frozen: false };
}

export async function resetClock(db: Db) {
  await writeOffset(db, 0);
  await refreshClock();
}

export async function getClockOffset(db: Db) {
  return readOffset(db);
}

/** Run every due job now, until nothing is due at the current (simulated) time. */
export async function drainDue(_db: Db, max = 100): Promise<number> {
  assertDryRun();
  let total = 0;
  for (let i = 0; i < max; i++) {
    const n = await tick(`simulator:${process.pid}`, 20);
    total += n;
    if (n === 0) break;
  }
  return total;
}

/**
 * Fast-forward `ms` in steps of at most `stepMs`, stopping at each due job's run time and draining,
 * so scheduled sends go out at their right simulated times (and inside the send window).
 */
export async function advanceAndRun(db: Db, ms: number, stepMs = HOUR_MS): Promise<{ jobs: number; steps: number }> {
  assertDryRun();
  let jobs = await drainDue(db);
  const end = now().getTime() + ms;
  let steps = 0;
  while (now().getTime() < end && steps < 1000) {
    const next = await maybeOne<{ run_at: Date }>(db, "select run_at from jobs where status = 'queued' order by run_at limit 1");
    const nextAt = next ? next.run_at.getTime() : end;
    const target = Math.min(end, Math.max(now().getTime() + 1000, nextAt));
    await advanceClock(db, Math.min(target - now().getTime(), stepMs));
    jobs += await drainDue(db);
    steps++;
  }
  return { jobs, steps };
}

/** A fake number in the reserved 555-01xx range, unused by any lead in the org. */
export async function fakePhone(db: Db, orgId: string): Promise<string> {
  const used = new Set((await q<{ phone_e164: string }>(db, "select phone_e164 from leads where org_id = $1 and phone_e164 like '+163055501%'", [orgId])).map((r) => r.phone_e164));
  const free = Array.from({ length: 100 }, (_, i) => `+163055501${String(i).padStart(2, "0")}`).filter((p) => !used.has(p));
  if (free.length === 0) throw new Error("All 100 simulator phone numbers are in use. Reset simulated leads first.");
  return free[Math.floor(Math.random() * free.length)];
}

export interface SimLeadInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  zip?: string | null;
  answers?: Record<string, string>;
  campaign_name?: string | null;
}

/** Create a simulated lead through the real intake path, then run its first touch immediately. */
export async function createSimulatedLead(db: Db, orgId: string, sourceId: string, input: SimLeadInput): Promise<IntakeResult> {
  assertDryRun();
  const phone = input.phone?.trim() ? input.phone.trim() : await fakePhone(db, orgId);
  const r = await ingestLead(orgId, sourceId, {
    full_name: input.name || "Sim Lead",
    phone,
    email: input.email?.trim() || null,
    zip: input.zip?.trim() || null,
    campaign_name: input.campaign_name ?? "Simulator",
    answers: { ...(input.answers ?? {}), [SIM_MARK]: "true" },
  }, "simulator");
  if (r.status === "created" || r.status === "resubmitted") await runFirstTouchNow(r.leadId);
  return r;
}

export async function isSimulatedLead(db: Db, orgId: string, leadId: string): Promise<boolean> {
  return !!(await maybeOne(db, `select 1 from leads l where l.id = $1 and l.org_id = $2 and ${SIMULATED_SQL}`, [leadId, orgId]));
}

/** The lead texts (or emails) in. The agent reply is debounced 20s like production. */
export async function textAsLead(db: Db, orgId: string, leadId: string, body: string, channel: "sms" | "email" = "sms") {
  assertDryRun();
  if (!(await isSimulatedLead(db, orgId, leadId))) throw new Error("Not a simulated lead");
  return handleInbound(db, { orgId, leadId, channel, body, subject: channel === "email" ? "Re: your inquiry" : null });
}

/** Delete only simulated leads (messages, jobs, notifications cascade; consent records keep their row with lead_id null). */
export async function resetSimulatedLeads(db: Db, orgId: string): Promise<number> {
  const rows = await q<{ id: string }>(db, `delete from leads l where l.org_id = $1 and ${SIMULATED_SQL} returning l.id`, [orgId]);
  return rows.length;
}

export async function simulatedLeadCount(db: Db, orgId: string) {
  return (await one<{ n: number }>(db, `select count(*)::int as n from leads l where l.org_id = $1 and ${SIMULATED_SQL}`, [orgId])).n;
}
