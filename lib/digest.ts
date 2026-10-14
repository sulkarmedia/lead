// 6pm daily owner email: new leads, appointments set, shows, and any handoff still waiting.
import type { Db } from "./db";
import { one, q } from "./db";
import type { Org } from "./db/types";
import { now } from "./clock";
import { notifyUser, leadLink } from "./notify";
import { env } from "./env";

export async function digestStats(db: Db, orgId: string, since: Date) {
  const [s] = await q<{ new_leads: number; appts: number; shows: number; sold: number }>(
    db,
    `select (select count(*) from leads where org_id = $1 and created_at >= $2)::int as new_leads,
            (select count(*) from stage_events where org_id = $1 and to_stage = 'appointment_set' and created_at >= $2)::int as appts,
            (select count(*) from stage_events where org_id = $1 and to_stage = 'showed' and created_at >= $2)::int as shows,
            (select count(*) from stage_events where org_id = $1 and to_stage = 'sold' and created_at >= $2)::int as sold`,
    [orgId, since],
  );
  const waiting = await q<{ id: string; full_name: string | null; handoff_at: Date }>(
    db,
    `select l.id, l.full_name, l.handoff_at from leads l
      where l.org_id = $1 and l.ai_status = 'paused' and l.handoff_at is not null
        and not exists (select 1 from messages m where m.lead_id = l.id and m.author = 'user' and m.created_at >= l.handoff_at)
      order by l.handoff_at`,
    [orgId],
  );
  return { ...s, waiting };
}

export async function dailyDigest(db: Db, orgId: string) {
  const org = await one<Org>(db, "select * from organizations where id = $1", [orgId]);
  const since = new Date(now().getTime() - 24 * 3600_000);
  const s = await digestStats(db, orgId, since);
  const lines = [
    `${org.name}: last 24 hours`,
    `New leads: ${s.new_leads}`,
    `Appointments set: ${s.appts}`,
    `Shows: ${s.shows}`,
    `Sold: ${s.sold}`,
    s.waiting.length ? `\nHandoffs still waiting on a rep (${s.waiting.length}):\n` + s.waiting.map((w) => `- ${w.full_name ?? "Lead"}: ${leadLink(w.id)}`).join("\n") : "\nNo handoffs waiting.",
    `\nDashboard: ${env.appUrl}/dashboard`,
  ];
  const owners = await q<{ user_id: string }>(db, "select user_id from memberships where org_id = $1 and active and role = 'owner'", [orgId]);
  for (const o of owners) {
    await notifyUser(db, { orgId, userId: o.user_id, kind: "daily_digest", subject: `${org.name} daily summary`, body: lines.join("\n"), channels: ["email"] });
  }
}
