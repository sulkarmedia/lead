// Handoff to a human: pause the AI, alert the assigned rep (SMS + email), start the SLA clock.
// No rep reply in 10 business-hour minutes → alert the backup/manager; at 30 the AI resumes.
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { Lead, Org } from "./db/types";
import { now } from "./clock";
import { enqueue } from "./jobs";
import { leadLink, notifyUser } from "./notify";
import { stopCadence } from "./cadence";
import { addBusinessMinutes } from "./booking/hours";
import { loadAvailability } from "./booking/book";

export const SLA_ESCALATE_MIN = 10;
export const SLA_RESUME_MIN = 30;

export async function handoff(db: Db, leadId: string, reason: string, opts: { summary?: string | null } = {}) {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  const at = now();
  await q(db, "update leads set ai_status = 'paused', ai_paused_reason = $2, handoff_at = $3, summary = coalesce($4, summary) where id = $1",
    [leadId, `handoff: ${reason}`, at, opts.summary ?? null]);
  await stopCadence(db, leadId);
  await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, status, purpose, created_at)
               values ($1, $2, 'system', 'internal', 'system', $3, 'received', 'handoff', $4)`,
    [org.id, leadId, `Handed off to ${lead.assigned_user_id ? "the assigned rep" : "the team"}: ${reason}`, at]);

  const summary = (opts.summary ?? lead.summary ?? "").split("\n").slice(0, 3).join("\n");
  const name = lead.full_name ?? lead.phone_e164 ?? lead.email ?? "A lead";
  const target = lead.assigned_user_id ?? org.default_owner_user_id ?? org.backup_user_id;
  if (target) {
    await notifyUser(db, {
      orgId: org.id, userId: target, leadId, kind: "handoff",
      subject: `${name} needs you (${reason})`,
      body: `${summary}\n${leadLink(leadId)}`.trim(),
    });
  }
  const avail = await loadAvailability(db, org.id, lead.assigned_user_id);
  const escalateAt = addBusinessMinutes(at, SLA_ESCALATE_MIN, avail?.weekly_hours, org.timezone);
  await enqueue(db, { orgId: org.id, leadId, kind: "handoff_sla", runAt: escalateAt, payload: { stage: "escalate", handoff_at: at.toISOString() }, dedupeKey: `sla:${leadId}` });
}

/** Has a person replied in the thread since the handoff? */
export async function repRepliedSince(db: Db, leadId: string, since: Date): Promise<boolean> {
  return !!(await maybeOne(db, "select 1 from messages where lead_id = $1 and author = 'user' and direction = 'outbound' and created_at >= $2 limit 1", [leadId, since]));
}

export async function backupUserIds(db: Db, org: Org, excluding: string | null): Promise<string[]> {
  if (org.backup_user_id && org.backup_user_id !== excluding) return [org.backup_user_id];
  const rows = await q<{ user_id: string }>(db, "select user_id from memberships where org_id = $1 and active and role in ('owner', 'admin') and user_id is distinct from $2", [org.id, excluding]);
  return rows.map((r) => r.user_id);
}
