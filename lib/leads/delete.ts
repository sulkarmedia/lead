// Lead deletion request: remove personal data, keep a keyed hash of the phone on do_not_contact so the
// person is never texted again. Consent records and message logs are retained for the TCPA claim
// window (at least 4 years; attorney to confirm), with the lead row itself scrubbed.
import type { Db } from "../db";
import { one, q } from "../db";
import type { Lead } from "../db/types";
import { phoneHash } from "../crypto";
import { now } from "../clock";
import { cancelJobs } from "../jobs";

export async function deleteLeadData(db: Db, leadId: string, actor: string) {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [leadId]);
  if (lead.phone_e164) {
    await q(db, "insert into do_not_contact (org_id, phone_hash, reason, created_at) values ($1, $2, 'deletion_request', $3) on conflict do nothing", [lead.org_id, phoneHash(lead.phone_e164), now()]);
  }
  await cancelJobs(db, leadId);
  await q(db, `update leads set first_name = null, last_name = null, full_name = '[deleted]', phone_e164 = null, email = null, zip = null,
                 answers = '{}', qualification = '{}', summary = null, ai_status = 'stopped', ai_paused_reason = 'deleted',
                 opted_out_sms_at = coalesce(opted_out_sms_at, $2), opted_out_email_at = coalesce(opted_out_email_at, $2), deleted_at = $2 where id = $1`, [leadId, now()]);
  await q(db, "update messages set status = 'blocked', blocked_reason = 'lead_deleted' where lead_id = $1 and status in ('queued', 'pending_approval')", [leadId]);
  await q(db, "insert into audit_log (org_id, actor, action, entity, entity_id, created_at) values ($1, $2, 'delete_personal_data', 'lead', $3, $4)", [lead.org_id, actor, leadId, now()]);
}
