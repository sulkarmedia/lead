// Cross-tenant health reads for the platform admin screens. Callers must check ctx.isPlatformAdmin
// and audit the view before calling (these use the service connection, which bypasses RLS).
import "server-only";
import { maybeOne, q, service } from "@/lib/db";
import { now } from "@/lib/clock";

export interface OrgHealth {
  id: string; name: string; slug: string; industry: string; timezone: string; status: string;
  texting_enabled: boolean; hipaa_baa_confirmed_at: Date | null; created_at: Date;
  leads: number; leads_7d: number; members: number;
  failed_jobs_24h: number; failed_msgs_24h: number; integration_errors: number;
  outbound_7d: number; blocked_7d: number; contacted_7d: number; opt_outs_7d: number;
}

export async function orgHealth(orgId?: string): Promise<OrgHealth[]> {
  const t = now().getTime();
  const day = new Date(t - 86400_000);
  const week = new Date(t - 7 * 86400_000);
  return q<OrgHealth>(service(), `
    select o.id, o.name, o.slug, o.industry, o.timezone, o.status, o.texting_enabled, o.hipaa_baa_confirmed_at, o.created_at,
      (select count(*)::int from leads l where l.org_id = o.id and l.deleted_at is null) as leads,
      (select count(*)::int from leads l where l.org_id = o.id and l.created_at > $2) as leads_7d,
      (select count(*)::int from memberships m where m.org_id = o.id and m.active) as members,
      (select count(*)::int from jobs j where j.org_id = o.id and j.status = 'failed' and coalesce(j.finished_at, j.created_at) > $1) as failed_jobs_24h,
      (select count(*)::int from messages m where m.org_id = o.id and m.status = 'failed' and m.created_at > $1) as failed_msgs_24h,
      (select count(*)::int from integrations i where i.org_id = o.id and i.status = 'error') as integration_errors,
      (select count(*)::int from messages m where m.org_id = o.id and m.direction = 'outbound' and m.channel in ('sms', 'email') and m.created_at > $2) as outbound_7d,
      (select count(*)::int from messages m where m.org_id = o.id and m.direction = 'outbound' and m.status = 'blocked' and m.created_at > $2) as blocked_7d,
      (select count(distinct m.lead_id)::int from messages m where m.org_id = o.id and m.direction = 'outbound' and m.status in ('sent', 'delivered') and m.created_at > $2) as contacted_7d,
      (select count(*)::int from leads l where l.org_id = o.id and (l.opted_out_sms_at > $2 or l.opted_out_email_at > $2)) as opt_outs_7d
    from organizations o
    where ($3::uuid is null or o.id = $3)
    order by o.name`, [day, week, orgId ?? null]);
}

export async function workerHeartbeat(): Promise<{ ageSeconds: number; worker: string | null } | null> {
  // Real elapsed time (clock_timestamp), not the simulation clock: this is about the process being alive.
  const r = await maybeOne<{ age: number; worker: string | null }>(service(),
    "select extract(epoch from (clock_timestamp() - updated_at))::float8 as age, value->>'worker' as worker from platform_state where key = 'worker_heartbeat'");
  return r ? { ageSeconds: Math.max(0, Math.round(r.age)), worker: r.worker } : null;
}

export const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—");

export function fmtAge(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
