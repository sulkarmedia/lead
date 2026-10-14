// The outbound pipeline. Compliance runs when a message is queued AND again right before the
// provider call. Every outbound row stores its ai_run_id, consent reference and guard results.
import type { Db } from "../db";
import { maybeOne, one, q } from "../db";
import type { Lead, Message, Org } from "../db/types";
import { checkSend, type ComplianceResult } from "../compliance";
import { now } from "../clock";
import { env } from "../env";
import { enqueue } from "../jobs";
import { log } from "../log";
import { buildEmail } from "./email";
import { getSenders } from "./sender";
import { setStage } from "../leads/stages";

export interface OutboundInput {
  orgId: string;
  leadId: string;
  channel: "sms" | "email";
  body: string;
  subject?: string | null;
  author: "ai" | "user" | "system";
  authorUserId?: string | null;
  automated: boolean;
  isReply: boolean;
  purpose: string;
  aiRunId?: string | null;
  guardResult?: unknown;
  /** Hold in the inbox approval queue instead of sending. */
  requireApproval?: boolean;
  /** Outside the send window: schedule for the opening ("defer") or record as blocked. */
  ifOutsideWindow?: "defer" | "block";
}

export interface OutboundResult {
  messageId: string;
  status: Message["status"] | "scheduled";
  reason?: string;
  sendAt?: Date | null;
}

const BROADCAST_PURPOSES = new Set(["first_touch", "followup", "nurture"]);

export async function queueOutbound(db: Db, i: OutboundInput): Promise<OutboundResult> {
  const intent = { channel: i.channel, automated: i.automated, isReply: i.isReply, purpose: i.purpose };
  const c = await checkSend(db, i.leadId, intent);
  const insert = async (status: Message["status"], blockedReason: string | null, comp: ComplianceResult) =>
    (
      await one<{ id: string }>(
        db,
        `insert into messages (org_id, lead_id, channel, direction, author, author_user_id, body, subject, status,
                               blocked_reason, ai_run_id, consent_record_id, guard_result, is_automated, is_reply, purpose, created_at)
         values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
        [
          i.orgId, i.leadId, i.channel, i.author, i.authorUserId ?? null, i.body, i.subject ?? null, status, blockedReason,
          i.aiRunId ?? null, comp.consentRecordId ?? null,
          JSON.stringify({ guards: i.guardResult ?? null, compliance_at_queue: { ok: comp.ok, reason: comp.reason ?? null, checks: comp.checks } }),
          i.automated, i.isReply, i.purpose, now(),
        ],
      )
    ).id;

  if (!c.ok) {
    if (c.reason === "outside_send_window" && (i.ifOutsideWindow ?? "defer") === "defer" && c.retryAt) {
      const id = await insert(i.requireApproval ? "pending_approval" : "queued", null, c);
      if (!i.requireApproval) {
        await enqueue(db, { orgId: i.orgId, leadId: i.leadId, kind: "scheduled_send", runAt: c.retryAt, payload: { message_id: id }, dedupeKey: `send:${id}` });
      }
      log.info("send.deferred", { org_id: i.orgId, lead_id: i.leadId, message_id: id, until: c.retryAt });
      return { messageId: id, status: i.requireApproval ? "pending_approval" : "scheduled", sendAt: c.retryAt, reason: c.reason };
    }
    const id = await insert("blocked", c.reason ?? "blocked", c);
    log.info("send.blocked", { org_id: i.orgId, lead_id: i.leadId, message_id: id, reason: c.reason });
    return { messageId: id, status: "blocked", reason: c.reason };
  }
  if (i.requireApproval) {
    const id = await insert("pending_approval", null, c);
    return { messageId: id, status: "pending_approval" };
  }
  const id = await insert("queued", null, c);
  return deliverMessage(db, id);
}

/** Send a queued message now, re-checking compliance first. */
export async function deliverMessage(db: Db, messageId: string): Promise<OutboundResult> {
  const m = await one<Message>(db, "select * from messages where id = $1", [messageId]);
  if (m.status !== "queued") return { messageId, status: m.status, reason: "not_queued" };
  const lead = await one<Lead>(db, "select * from leads where id = $1", [m.lead_id]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [m.org_id]);
  const channel = m.channel as "sms" | "email";
  const c = await checkSend(db, m.lead_id, { channel, automated: m.is_automated, isReply: m.is_reply, purpose: m.purpose ?? undefined });
  const guard = { ...((m.guard_result as Record<string, unknown>) ?? {}), compliance_at_send: { ok: c.ok, reason: c.reason ?? null, checks: c.checks } };

  if (!c.ok) {
    if (c.reason === "outside_send_window" && c.retryAt) {
      await q(db, "update messages set guard_result = $2 where id = $1", [messageId, JSON.stringify(guard)]);
      await enqueue(db, { orgId: m.org_id, leadId: m.lead_id, kind: "scheduled_send", runAt: c.retryAt, payload: { message_id: messageId }, dedupeKey: `send:${messageId}` });
      return { messageId, status: "scheduled", sendAt: c.retryAt, reason: c.reason };
    }
    await q(db, "update messages set status = 'blocked', blocked_reason = $2, guard_result = $3 where id = $1", [messageId, c.reason, JSON.stringify(guard)]);
    log.info("send.blocked_at_send", { org_id: m.org_id, lead_id: m.lead_id, message_id: messageId, reason: c.reason });
    return { messageId, status: "blocked", reason: c.reason };
  }

  const senders = getSenders();
  const at = now();
  try {
    let providerId: string;
    let to: string;
    let from: string;
    if (channel === "sms") {
      to = lead.phone_e164!;
      from = org.sms_from_number ?? "dry-run";
      ({ providerId } = await senders.sms({
        to,
        from: org.sms_from_number,
        messagingServiceSid: org.twilio_messaging_service_sid,
        body: m.body,
        statusCallback: `${env.appUrl}/api/webhooks/twilio/status`,
      }));
    } else {
      const e = buildEmail(org, lead, m.body);
      to = lead.email!;
      from = e.from;
      ({ providerId } = await senders.email({
        from: e.from, to, replyTo: e.replyTo, subject: m.subject ?? `${org.name}`, text: e.text, html: e.html, headers: e.headers,
        stream: BROADCAST_PURPOSES.has(m.purpose ?? "") ? "broadcast" : "transactional",
      }));
    }
    await q(
      db,
      `update messages set status = 'sent', provider_message_id = $2, sent_at = $3, dry_run = $4, to_address = $5, from_address = $6,
              consent_record_id = coalesce(consent_record_id, $7), guard_result = $8 where id = $1`,
      [messageId, providerId, at, senders.dryRun, to, from, c.consentRecordId ?? null, JSON.stringify(guard)],
    );
    await q(
      db,
      `update leads set last_outbound_at = $2, first_outbound_at = coalesce(first_outbound_at, $2),
              touch_count = touch_count + case when $3 then 1 else 0 end where id = $1`,
      [m.lead_id, at, m.is_automated && !m.is_reply],
    );
    if (lead.stage === "new") await setStage(db, lead.id, "contacted", "system");
    log.info("send.sent", { org_id: m.org_id, lead_id: m.lead_id, message_id: messageId, channel, dry_run: senders.dryRun });
    return { messageId, status: "sent" };
  } catch (e) {
    const err = (e as Error).message;
    await q(db, "update messages set status = 'failed', error = $2, guard_result = $3 where id = $1", [messageId, err.slice(0, 1000), JSON.stringify(guard)]);
    log.error("send.failed", { org_id: m.org_id, lead_id: m.lead_id, message_id: messageId, channel, error: err });
    return { messageId, status: "failed", reason: err };
  }
}

/** A rep approves (optionally edits) a held AI message. Compliance is re-checked on send. */
export async function approveMessage(db: Db, messageId: string, userId: string, editedBody?: string): Promise<OutboundResult> {
  const m = await maybeOne<Message>(db, "select * from messages where id = $1 and status = 'pending_approval'", [messageId]);
  if (!m) return { messageId, status: "blocked", reason: "not_pending" };
  await q(db, "update messages set status = 'queued', body = coalesce($2, body), author_user_id = $3 where id = $1", [messageId, editedBody ?? null, userId]);
  return deliverMessage(db, messageId);
}

export async function rejectMessage(db: Db, messageId: string) {
  await q(db, "update messages set status = 'blocked', blocked_reason = 'rejected_by_rep' where id = $1 and status = 'pending_approval'", [messageId]);
}
