// The worker's queue: a table polled with FOR UPDATE SKIP LOCKED. No workflow engine.
import type { Db } from "./db";
import { q } from "./db";
import type { Job, JobKind } from "./db/types";
import { now } from "./clock";

export interface EnqueueInput {
  orgId: string;
  leadId?: string | null;
  kind: JobKind;
  runAt?: Date;
  payload?: Record<string, unknown>;
  /** At most one queued/running job per key. A duplicate enqueue is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(db: Db, j: EnqueueInput): Promise<string | null> {
  const rows = await q<{ id: string }>(
    db,
    `insert into jobs (org_id, lead_id, kind, run_at, payload, dedupe_key, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (dedupe_key) where dedupe_key is not null and status = 'queued' do nothing
     returning id`,
    [j.orgId, j.leadId ?? null, j.kind, j.runAt ?? now(), j.payload ?? {}, j.dedupeKey ?? null, j.maxAttempts ?? 5],
  );
  return rows[0]?.id ?? null;
}

/** Cancel queued jobs for a lead, optionally limited to some kinds. */
export async function cancelJobs(db: Db, leadId: string, kinds?: JobKind[]): Promise<number> {
  const rows = await q(
    db,
    `update jobs set status = 'canceled', finished_at = $3
      where lead_id = $1 and status = 'queued' and ($2::job_kind[] is null or kind = any($2))
      returning id`,
    [leadId, kinds ?? null, now()],
  );
  return rows.length;
}

/** Claim up to `limit` due jobs. Two workers never get the same job. */
export async function claimJobs(db: Db, workerId: string, limit = 10): Promise<Job[]> {
  const at = now();
  // Reclaim jobs whose worker died mid-run (locked for more than 5 minutes).
  await q(db, `update jobs set status = 'queued', locked_at = null, locked_by = null
                where status = 'running' and locked_at < $1`, [new Date(at.getTime() - 5 * 60_000)]);
  return q<Job>(
    db,
    `update jobs set status = 'running', locked_at = $3, locked_by = $1, attempts = attempts + 1
      where id in (
        select id from jobs where status = 'queued' and run_at <= $3
         order by run_at limit $2 for update skip locked
      ) returning *`,
    [workerId, limit, at],
  );
}

export async function completeJob(db: Db, id: string) {
  await q(db, "update jobs set status = 'done', finished_at = $2, locked_at = null where id = $1", [id, now()]);
}

/** Retry with exponential backoff (30s, 2m, 8m, 32m, ...) until max_attempts. */
export async function failJob(db: Db, job: Job, err: unknown, opts: { retryAt?: Date } = {}) {
  const msg = err instanceof Error ? err.message : String(err);
  if (job.attempts >= job.max_attempts) {
    await q(db, "update jobs set status = 'failed', last_error = $2, finished_at = $3, locked_at = null where id = $1", [job.id, msg.slice(0, 2000), now()]);
    return;
  }
  const delay = 30_000 * 4 ** (job.attempts - 1);
  const runAt = opts.retryAt ?? new Date(now().getTime() + Math.min(delay, 6 * 3600_000));
  await q(db, "update jobs set status = 'queued', last_error = $2, run_at = $3, locked_at = null, locked_by = null where id = $1", [job.id, msg.slice(0, 2000), runAt]);
}

/** Put a job back for later without counting it as a failure (e.g. waiting for the send window). */
export async function rescheduleJob(db: Db, id: string, runAt: Date) {
  await q(db, "update jobs set status = 'queued', run_at = $2, attempts = greatest(attempts - 1, 0), locked_at = null, locked_by = null where id = $1", [id, runAt]);
}

/** Claim one specific job if it is due and unclaimed (the web fast path for first touch). */
export async function claimJobById(db: Db, id: string, workerId: string): Promise<Job | null> {
  const rows = await q<Job>(
    db,
    `update jobs set status = 'running', locked_at = $3, locked_by = $2, attempts = attempts + 1
      where id = (select id from jobs where id = $1 and status = 'queued' and run_at <= $3 for update skip locked)
      returning *`,
    [id, workerId, now()],
  );
  return rows[0] ?? null;
}
