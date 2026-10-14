// Lead list filters shared by the /leads page (board + table) and the CSV export route.
// Builds a parameterized WHERE clause; dates are YYYY-MM-DD in the org's time zone.
import { DateTime } from "luxon";
import type { Db } from "@/lib/db";
import { q } from "@/lib/db";
import { STAGES } from "@/lib/db/types";

export interface LeadFilters {
  q?: string;
  source?: string;
  campaign?: string;
  ad?: string;
  rep?: string; // user id, or "none" for unassigned
  stage?: string;
  ai?: string;
  from?: string;
  to?: string;
}

export const FILTER_KEYS = ["q", "source", "campaign", "ad", "rep", "stage", "ai", "from", "to"] as const;

const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function parseFilters(sp: Record<string, string | string[] | undefined> | URLSearchParams): LeadFilters {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  const f: LeadFilters = {};
  for (const k of FILTER_KEYS) f[k] = get(k);
  return f;
}

/** Query string with the active filters (for links that keep them, e.g. CSV export). */
export function filterQuery(f: LeadFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]!);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function hasFilters(f: LeadFilters) {
  return FILTER_KEYS.some((k) => !!f[k]);
}

export function buildWhere(orgId: string, tz: string, f: LeadFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  const conds = ["l.org_id = $1", "l.deleted_at is null"];
  const add = (sql: (n: string) => string, v: unknown) => {
    params.push(v);
    conds.push(sql(`$${params.length}`));
  };
  if (f.q) {
    const digits = f.q.replace(/\D/g, "");
    params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const t = `$${params.length}`;
    let phone = "";
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      phone = ` or l.phone_e164 like $${params.length}`;
    }
    conds.push(`(l.full_name ilike ${t} or l.email ilike ${t} or l.phone_e164 ilike ${t}${phone})`);
  }
  if (f.source && isUuid(f.source)) add((n) => `l.source_id = ${n}`, f.source);
  if (f.campaign) add((n) => `coalesce(l.campaign_name, l.campaign_id) = ${n}`, f.campaign);
  if (f.ad) add((n) => `coalesce(l.ad_name, l.ad_id) = ${n}`, f.ad);
  if (f.rep === "none") conds.push("l.assigned_user_id is null");
  else if (f.rep && isUuid(f.rep)) add((n) => `l.assigned_user_id = ${n}`, f.rep);
  if (f.stage && (STAGES as string[]).includes(f.stage)) add((n) => `l.stage = ${n}::lead_stage`, f.stage);
  if (f.ai && ["active", "paused", "stopped"].includes(f.ai)) add((n) => `l.ai_status = ${n}::ai_status`, f.ai);
  if (isDate(f.from)) add((n) => `l.created_at >= ${n}`, DateTime.fromISO(f.from!, { zone: tz }).startOf("day").toJSDate());
  if (isDate(f.to)) add((n) => `l.created_at < ${n}`, DateTime.fromISO(f.to!, { zone: tz }).plus({ days: 1 }).startOf("day").toJSDate());
  return { where: conds.join(" and "), params };
}

export interface LeadListRow {
  id: string;
  full_name: string | null;
  phone_e164: string | null;
  email: string | null;
  stage: string;
  ai_status: string;
  score: number;
  warm: boolean;
  split_arm: string;
  source_name: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  assigned_user_id: string | null;
  rep_name: string | null;
  summary: string | null;
  created_at: Date;
  first_outbound_at: Date | null;
  last_inbound_at: Date | null;
  updated_at: Date;
}

export async function listLeads(db: Db, orgId: string, tz: string, f: LeadFilters, limit = 500): Promise<LeadListRow[]> {
  const { where, params } = buildWhere(orgId, tz, f);
  params.push(limit);
  return q<LeadListRow>(
    db,
    `select l.id, l.full_name, l.phone_e164, l.email, l.stage, l.ai_status, l.score, l.warm, l.split_arm, s.name as source_name,
            coalesce(l.campaign_name, l.campaign_id) as campaign_name, l.adset_name, coalesce(l.ad_name, l.ad_id) as ad_name,
            l.assigned_user_id, m.display_name as rep_name, l.summary, l.created_at, l.first_outbound_at, l.last_inbound_at, l.updated_at
       from leads l
       left join lead_sources s on s.id = l.source_id
       left join memberships m on m.org_id = l.org_id and m.user_id = l.assigned_user_id
      where ${where}
      order by l.created_at desc
      limit $${params.length}`,
    params,
  );
}

export async function filterOptions(db: Db, orgId: string) {
  const [sources, campaigns, ads, reps] = await Promise.all([
    q<{ id: string; name: string }>(db, "select id, name from lead_sources where org_id = $1 order by name", [orgId]),
    q<{ v: string }>(db, "select distinct coalesce(campaign_name, campaign_id) as v from leads where org_id = $1 and deleted_at is null and coalesce(campaign_name, campaign_id) is not null order by 1 limit 200", [orgId]),
    q<{ v: string }>(db, "select distinct coalesce(ad_name, ad_id) as v from leads where org_id = $1 and deleted_at is null and coalesce(ad_name, ad_id) is not null order by 1 limit 200", [orgId]),
    q<{ user_id: string; display_name: string }>(db, "select user_id, display_name from memberships where org_id = $1 and active order by display_name", [orgId]),
  ]);
  return { sources, campaigns: campaigns.map((r) => r.v), ads: ads.map((r) => r.v), reps };
}
