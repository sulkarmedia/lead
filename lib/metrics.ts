// Dashboard queries. Every function takes (db, orgId, range) and returns plain objects, so the page
// can call them inside withUserDb() (RLS applies) and tests can call them on the service connection.
//
// Definitions (leads created in [range.from, range.to), not deleted):
//  - contacted:    first_outbound_at is set
//  - replied:      any inbound message
//  - qualified:    reached qualified or later (current stage or any stage event)
//  - appointment:  has an appointment row, or reached appointment_set or later
//  - showed:       has an appointment that showed, or reached showed/sold (only among appointments)
//  - sold:         reached sold
//  - speed to lead: first_outbound_at - created_at, median over contacted leads
//  - human-handled: any message with author='user' and direction='outbound'; otherwise AI-handled
// Control-arm leads (split_arm='control') are left out of every AI metric; armComparison() shows them.
import type { Db } from "./db";
import { q } from "./db";

export interface Range { from: Date; to: Date }

export interface FunnelRow {
  key: string;
  leads: number;
  contacted: number;
  replied: number;
  qualified: number;
  appointments: number;
  showed: number;
  sold: number;
  medianSpeedSec: number | null;
  replyRate: number | null; // replied / contacted
  qualifiedRate: number | null; // qualified / leads
  appointmentRate: number | null; // appointments / leads
  showRate: number | null; // showed / appointments
  soldRate: number | null; // sold / leads
}

export type BreakdownBy = "form" | "campaign" | "ad" | "rep" | "handler";

const KEY: Record<BreakdownBy | "arm" | "all", string> = {
  all: "'all'",
  form: "form_key",
  campaign: "campaign_key",
  ad: "ad_key",
  rep: "rep_key",
  handler: "case when human then 'human' else 'ai' end",
  arm: "split_arm",
};

const BASE = `
  with base as (
    select l.id, l.created_at, l.first_outbound_at, l.split_arm, l.campaign_id, l.campaign_name,
           coalesce(s.name, l.meta_form_id, 'Unknown form') as form_key,
           coalesce(l.campaign_name, l.campaign_id, 'No campaign') as campaign_key,
           coalesce(l.ad_name, l.ad_id, 'No ad') as ad_key,
           coalesce(m.display_name, 'Unassigned') as rep_key,
           (l.first_outbound_at is not null) as contacted,
           exists (select 1 from messages x where x.lead_id = l.id and x.direction = 'inbound') as replied,
           exists (select 1 from messages x where x.lead_id = l.id and x.author = 'user' and x.direction = 'outbound') as human,
           (l.stage in ('qualified', 'appointment_set', 'showed', 'sold')
             or exists (select 1 from stage_events e where e.lead_id = l.id and e.to_stage in ('qualified', 'appointment_set', 'showed', 'sold'))) as qualified,
           (l.stage in ('appointment_set', 'showed', 'sold')
             or exists (select 1 from appointments a where a.lead_id = l.id)
             or exists (select 1 from stage_events e where e.lead_id = l.id and e.to_stage in ('appointment_set', 'showed', 'sold'))) as appointment,
           (l.stage in ('showed', 'sold')
             or exists (select 1 from appointments a where a.lead_id = l.id and a.status = 'showed')
             or exists (select 1 from stage_events e where e.lead_id = l.id and e.to_stage in ('showed', 'sold'))) as showed_any,
           (l.stage = 'sold' or exists (select 1 from stage_events e where e.lead_id = l.id and e.to_stage = 'sold')) as sold
      from leads l
      left join lead_sources s on s.id = l.source_id
      left join memberships m on m.org_id = l.org_id and m.user_id = l.assigned_user_id
     where l.org_id = $1 and l.deleted_at is null and l.created_at >= $2 and l.created_at < $3
  )`;

const AGG = `
  count(*)::int as leads,
  count(*) filter (where contacted)::int as contacted,
  count(*) filter (where replied and contacted)::int as replied,
  count(*) filter (where qualified)::int as qualified,
  count(*) filter (where appointment)::int as appointments,
  count(*) filter (where appointment and showed_any)::int as showed,
  count(*) filter (where sold)::int as sold,
  (percentile_cont(0.5) within group (order by extract(epoch from first_outbound_at - created_at))
     filter (where first_outbound_at is not null))::float8 as median_speed_sec`;

type RawRow = { key: string; leads: number; contacted: number; replied: number; qualified: number; appointments: number; showed: number; sold: number; median_speed_sec: number | null };

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

function toFunnel(r: RawRow): FunnelRow {
  return {
    key: r.key,
    leads: r.leads,
    contacted: r.contacted,
    replied: r.replied,
    qualified: r.qualified,
    appointments: r.appointments,
    showed: r.showed,
    sold: r.sold,
    medianSpeedSec: r.median_speed_sec === null ? null : Math.round(r.median_speed_sec),
    replyRate: rate(r.replied, r.contacted),
    qualifiedRate: rate(r.qualified, r.leads),
    appointmentRate: rate(r.appointments, r.leads),
    showRate: rate(r.showed, r.appointments),
    soldRate: rate(r.sold, r.leads),
  };
}

async function grouped(db: Db, orgId: string, range: Range, by: keyof typeof KEY, agentOnly: boolean): Promise<FunnelRow[]> {
  const rows = await q<RawRow>(
    db,
    `${BASE}
     select ${KEY[by]} as key, ${AGG}
       from base ${agentOnly ? "where split_arm = 'agent'" : ""}
      group by 1 order by count(*) desc, 1`,
    [orgId, range.from, range.to],
  );
  return rows.map(toFunnel);
}

const EMPTY: RawRow = { key: "all", leads: 0, contacted: 0, replied: 0, qualified: 0, appointments: 0, showed: 0, sold: 0, median_speed_sec: null };

/** Headline numbers for agent-arm leads. */
export async function summary(db: Db, orgId: string, range: Range): Promise<FunnelRow> {
  const [r] = await grouped(db, orgId, range, "all", true);
  return r ?? toFunnel(EMPTY);
}

/** Agent-arm funnel split by form, campaign, ad, rep, or AI- vs human-handled ("ai" / "human"). */
export async function breakdown(db: Db, orgId: string, range: Range, by: BreakdownBy): Promise<FunnelRow[]> {
  return grouped(db, orgId, range, by, true);
}

/** Agent vs control (the pilot's 50/50 split). Always returns both arms, in that order. */
export async function armComparison(db: Db, orgId: string, range: Range): Promise<FunnelRow[]> {
  const rows = await grouped(db, orgId, range, "arm", false);
  return (["agent", "control"] as const).map((arm) => rows.find((r) => r.key === arm) ?? toFunnel({ ...EMPTY, key: arm }));
}

export interface CampaignCost { campaignId: string; campaignName: string | null; spend: number; appointments: number; costPerAppointment: number | null }

/**
 * Cost per appointment by campaign from ad_spend_daily. Spend days are taken in the org's time zone;
 * appointments count every lead (both arms) created in the range from that campaign, matched by
 * campaign id, or by name when the lead has no id. Empty when no spend rows exist.
 */
export async function costPerAppointment(db: Db, orgId: string, range: Range): Promise<CampaignCost[]> {
  const rows = await q<{ campaign_id: string; campaign_name: string | null; spend: number; appointments: number }>(
    db,
    `${BASE},
     tz as (select timezone from organizations where id = $1),
     spend as (
       select d.campaign_id, max(d.campaign_name) as campaign_name, sum(d.spend)::float8 as spend
         from ad_spend_daily d, tz
        where d.org_id = $1 and d.day >= ($2::timestamptz at time zone tz.timezone)::date and d.day < ($3::timestamptz at time zone tz.timezone)::date
        group by d.campaign_id
     )
     select s.campaign_id, s.campaign_name, s.spend,
            (select count(*) from base b where b.appointment
               and (b.campaign_id = s.campaign_id or (b.campaign_id is null and b.campaign_name = s.campaign_name)))::int as appointments
       from spend s
      order by s.spend desc, s.campaign_id`,
    [orgId, range.from, range.to],
  );
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    spend: r.spend,
    appointments: r.appointments,
    costPerAppointment: r.appointments > 0 ? Math.round((r.spend / r.appointments) * 100) / 100 : null,
  }));
}

export interface DashboardData {
  summary: FunnelRow;
  byForm: FunnelRow[];
  byCampaign: FunnelRow[];
  byAd: FunnelRow[];
  byRep: FunnelRow[];
  byHandler: FunnelRow[];
  arms: FunnelRow[];
  cost: CampaignCost[];
}

/** Everything the dashboard shows. Sequential: db may be a single client inside a transaction. */
export async function dashboard(db: Db, orgId: string, range: Range): Promise<DashboardData> {
  return {
    summary: await summary(db, orgId, range),
    byForm: await breakdown(db, orgId, range, "form"),
    byCampaign: await breakdown(db, orgId, range, "campaign"),
    byAd: await breakdown(db, orgId, range, "ad"),
    byRep: await breakdown(db, orgId, range, "rep"),
    byHandler: await breakdown(db, orgId, range, "handler"),
    arms: await armComparison(db, orgId, range),
    cost: await costPerAppointment(db, orgId, range),
  };
}
