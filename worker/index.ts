// Worker: polls due jobs every WORKER_POLL_SECONDS with FOR UPDATE SKIP LOCKED, so any number of
// workers can run and each due job runs exactly once. Writes a heartbeat for /api/health.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { service, q, maybeOne } from "../lib/db";
import { claimJobs, completeJob, failJob, rescheduleJob } from "../lib/jobs";
import { env } from "../lib/env";
import { log } from "../lib/log";
import { now, setOffsetMs } from "../lib/clock";
import { RetryLater } from "../lib/conversation";
import { handleJob, Reschedule, scheduleRecurring } from "./handlers";

export const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 6)}`;

export async function refreshClock() {
  if (!env.dryRun) return setOffsetMs(0);
  const row = await maybeOne<{ value: { ms: number } }>(service(), "select value from platform_state where key = 'clock_offset_ms'");
  setOffsetMs(row?.value.ms ?? 0);
}

/** Claim and run one batch. Returns the number of jobs processed. */
export async function tick(id = workerId, batch = 10): Promise<number> {
  const db = service();
  const jobs = await claimJobs(db, id, batch);
  for (const job of jobs) {
    const started = Date.now();
    try {
      await handleJob(db, job);
      await completeJob(db, job.id);
      log.info("job.done", { job_id: job.id, kind: job.kind, org_id: job.org_id, lead_id: job.lead_id, ms: Date.now() - started });
    } catch (e) {
      if (e instanceof Reschedule) {
        await rescheduleJob(db, job.id, e.runAt);
      } else {
        await failJob(db, job, e);
        const level = e instanceof RetryLater ? "warn" : "error";
        log[level]("job.failed", { job_id: job.id, kind: job.kind, org_id: job.org_id, lead_id: job.lead_id, attempt: job.attempts, error: (e as Error).message });
      }
    }
  }
  return jobs.length;
}

async function heartbeat() {
  await q(service(), `insert into platform_state (key, value, updated_at) values ('worker_heartbeat', $1, now())
                      on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify({ worker: workerId, at: new Date().toISOString() })]);
}

async function main() {
  log.info("worker.start", { worker: workerId, dry_run: env.dryRun, poll_seconds: env.workerPollSeconds });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let lastRecurring = 0;
  while (!stopping) {
    try {
      await refreshClock();
      await heartbeat();
      if (Date.now() - lastRecurring > 5 * 60_000) {
        await scheduleRecurring(service());
        lastRecurring = Date.now();
      }
      // Drain everything due, then sleep.
      while (!stopping && (await tick()) > 0) await refreshClock();
    } catch (e) {
      log.error("worker.loop_error", { error: (e as Error).message });
    }
    const sleepMs = env.workerPollSeconds * 1000;
    const until = Date.now() + sleepMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }
  log.info("worker.stop", { worker: workerId, at: now().toISOString() });
  await service().end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error("worker.crash", { error: (e as Error).message });
    process.exit(1);
  });
}
