// Rep actions from the inbox and lead page. A rep reply pauses the AI; one button hands it back.
import type { Db } from "./db";
import { one, q } from "./db";
import type { Lead } from "./db/types";
import { now } from "./clock";
import { cancelJobs } from "./jobs";
import { queueOutbound, type OutboundResult } from "./messaging/send";
import { restartAsWentQuiet, scheduleNextFollowup, stopCadence } from "./cadence";
import { setStage } from "./leads/stages";

export async function sendAsRep(db: Db, input: { leadId: string; userId: string; channel: "sms" | "email" | "note"; body: string; subject?: string | null }): Promise<OutboundResult | { messageId: string; status: "note" }> {
  const lead = await one<Lead>(db, "select * from leads where id = $1", [input.leadId]);
  if (input.channel === "note") {
    const m = await one<{ id: string }>(db, `insert into messages (org_id, lead_id, channel, direction, author, author_user_id, body, status, purpose, created_at)
                                         values ($1, $2, 'note', 'internal', 'user', $3, $4, 'received', 'note', $5) returning id`, [lead.org_id, lead.id, input.userId, input.body, now()]);
    return { messageId: m.id, status: "note" };
  }
  // A person is now talking: the AI steps back and the cadence stops.
  await q(db, "update leads set ai_status = case when ai_status = 'stopped' then ai_status else 'paused' end, ai_paused_reason = case when ai_status = 'stopped' then ai_paused_reason else 'rep_took_over' end, assigned_user_id = coalesce(assigned_user_id, $2) where id = $1", [lead.id, input.userId]);
  await stopCadence(db, lead.id);
  await cancelJobs(db, lead.id, ["agent_reply"]);
  const res = await queueOutbound(db, {
    orgId: lead.org_id, leadId: lead.id, channel: input.channel, body: input.body, subject: input.subject ?? null, author: "user", authorUserId: input.userId,
    automated: false, isReply: true, purpose: "rep", ifOutsideWindow: "defer",
  });
  if (lead.stage === "new" || lead.stage === "contacted") await setStage(db, lead.id, "engaged", `user:${input.userId}`, { onlyForward: true });
  return res;
}

export async function handBackToAi(db: Db, leadId: string, userId: string) {
  const lead = await one<Lead>(db, "update leads set ai_status = 'active', ai_paused_reason = null, handoff_at = null, low_confidence_streak = 0 where id = $1 and ai_status = 'paused' returning *", [leadId]);
  await q(db, `insert into messages (org_id, lead_id, channel, direction, author, author_user_id, body, status, purpose, created_at) values ($1, $2, 'system', 'internal', 'user', $3, 'Handed back to the AI.', 'received', 'note', $4)`, [lead.org_id, leadId, userId, now()]);
  await cancelJobs(db, leadId, ["handoff_sla"]);
  // Resume the cadence from where the conversation is.
  if (lead.last_inbound_at) await restartAsWentQuiet(db, leadId);
  else await scheduleNextFollowup(db, leadId);
}

export async function setAiStatus(db: Db, leadId: string, userId: string, status: "paused" | "stopped" | "active") {
  if (status === "active") return handBackToAi(db, leadId, userId);
  const lead = await one<Lead>(db, "update leads set ai_status = $2, ai_paused_reason = $3 where id = $1 returning *", [leadId, status, `${status}_by_rep`]);
  await stopCadence(db, leadId);
  await cancelJobs(db, leadId, ["agent_reply", "handoff_sla"]);
  await q(db, `insert into messages (org_id, lead_id, channel, direction, author, author_user_id, body, status, purpose, created_at) values ($1, $2, 'system', 'internal', 'user', $3, $4, 'received', 'note', $5)`,
    [lead.org_id, leadId, userId, status === "paused" ? "AI paused by rep." : "AI stopped by rep.", now()]);
}
