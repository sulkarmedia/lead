// Speed to lead: the intake route runs the lead's first_touch job right away instead of waiting
// for the next worker poll. Claiming uses the same SKIP LOCKED rule, so it still runs exactly once.
import { service, maybeOne } from "../lib/db";
import { claimJobById, completeJob, failJob } from "../lib/jobs";
import { log } from "../lib/log";
import { handleJob } from "./handlers";

export async function runFirstTouchNow(leadId: string) {
  const db = service();
  const job = await maybeOne<{ id: string }>(db, "select id from jobs where lead_id = $1 and kind = 'first_touch' and status = 'queued' order by created_at desc limit 1", [leadId]);
  if (!job) return;
  const claimed = await claimJobById(db, job.id, `web:${process.pid}`);
  if (!claimed) return;
  try {
    await handleJob(db, claimed);
    await completeJob(db, claimed.id);
  } catch (e) {
    await failJob(db, claimed, e);
    log.warn("fastpath.failed", { lead_id: leadId, error: (e as Error).message });
  }
}
