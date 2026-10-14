// Platform alerts: worker heartbeat older than 2 minutes, or a spike in failed jobs, texts the
// platform owner (PLATFORM_ALERT_PHONE, from TWILIO_ALERT_NUMBER) and reports to Sentry. Runs from
// /api/health (so a dead worker is still noticed) and from the worker loop. Throttled to one per 30 min.
import type { Db } from "./db";
import { maybeOne, q } from "./db";
import { env } from "./env";
import { log } from "./log";
import { getSenders } from "./messaging/sender";

export async function watchdog(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const hb = await maybeOne<{ updated_at: Date }>(db, "select updated_at from platform_state where key = 'worker_heartbeat'");
  if (!hb || Date.now() - hb.updated_at.getTime() > 120_000) problems.push(`worker heartbeat ${hb ? Math.round((Date.now() - hb.updated_at.getTime()) / 1000) + "s old" : "missing"}`);
  const f = await maybeOne<{ n: number }>(db, "select count(*)::int as n from jobs where status = 'failed' and finished_at > now() - interval '15 minutes'");
  if ((f?.n ?? 0) >= Number(process.env.FAILED_JOB_ALERT_THRESHOLD ?? 10)) problems.push(`${f!.n} jobs failed in 15 minutes`);
  if (problems.length === 0) return problems;
  const last = await maybeOne<{ updated_at: Date }>(db, "select updated_at from platform_state where key = 'last_platform_alert'");
  if (last && Date.now() - last.updated_at.getTime() < 30 * 60_000) return problems;
  await q(db, `insert into platform_state (key, value, updated_at) values ('last_platform_alert', $1, now())
               on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify({ problems })]);
  log.error("platform.alert", { problems });
  const to = process.env.PLATFORM_ALERT_PHONE;
  if (to) {
    try {
      await getSenders().sms({ to, from: env.twilioAlertNumber ?? "alert-dry-run", body: `${env.appName} ALERT: ${problems.join("; ")}` });
    } catch (e) {
      log.error("platform.alert_sms_failed", { error: (e as Error).message });
    }
  }
  return problems;
}
