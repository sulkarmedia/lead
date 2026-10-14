// Health: database, worker heartbeat (last poll under 60s), provider configuration, failed-job rate.
import { maybeOne, service } from "@/lib/db";
import { env } from "@/lib/env";
import { json } from "@/lib/http";
import { watchdog } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    await maybeOne(service(), "select 1");
    checks.database = "ok";
  } catch (e) {
    checks.database = (e as Error).message;
    ok = false;
  }
  try {
    const hb = await maybeOne<{ updated_at: Date }>(service(), "select updated_at from platform_state where key = 'worker_heartbeat'");
    const age = hb ? (Date.now() - hb.updated_at.getTime()) / 1000 : null;
    checks.worker_heartbeat_age_s = age;
    if (age === null || age > 60) ok = false;
    const f = await maybeOne<{ failed: number }>(service(), "select count(*)::int as failed from jobs where status = 'failed' and finished_at > now() - interval '1 hour'");
    checks.failed_jobs_last_hour = f?.failed ?? 0;
  } catch {
    ok = false;
  }
  checks.providers = {
    anthropic: !!env.anthropicApiKey, twilio: !!(env.twilioAccountSid && env.twilioAuthToken), postmark: !!env.postmarkServerToken,
    meta: !!(env.metaAppId && env.metaAppSecret), google: !!(env.googleClientId && env.googleClientSecret),
  };
  checks.dry_run = env.dryRun;
  checks.alerts = await watchdog(service()).catch(() => []);
  return json({ ok, ...checks }, ok ? 200 : 503);
}
