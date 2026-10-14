// Inbound SMS. Verify X-Twilio-Signature, match the lead by sender + receiving number, store, then
// run the conversation engine (opt-out first). Replies with empty TwiML; we send through the API.
import { maybeOne, one, q, service } from "@/lib/db";
import type { Org } from "@/lib/db/types";
import { env } from "@/lib/env";
import { verifyTwilioSignature } from "@/lib/integrations/twilio";
import { handleInbound } from "@/lib/conversation";
import { normalizePhone } from "@/lib/leads/normalize";
import { ensureSource } from "@/lib/leads/intake";
import { publicUrl } from "@/lib/http";
import { log } from "@/lib/log";
import { notifyUser } from "@/lib/notify";
import { now } from "@/lib/clock";

const twiml = (status = 200) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status, headers: { "content-type": "text/xml" } });

export async function POST(req: Request) {
  const params = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
  if (!verifyTwilioSignature(env.twilioAuthToken, publicUrl(req), params, req.headers.get("x-twilio-signature"))) {
    log.warn("webhook.twilio.bad_signature", {});
    return new Response("forbidden", { status: 403 });
  }
  const from = normalizePhone(params.From);
  const to = normalizePhone(params.To);
  const org = await maybeOne<Org>(service(), "select * from organizations where sms_from_number = $1 or twilio_messaging_service_sid = $2 limit 1", [to, params.MessagingServiceSid ?? ""]);
  if (!org || !from) {
    log.warn("webhook.twilio.unmatched", { to: params.To });
    return twiml();
  }
  let lead = await maybeOne<{ id: string }>(service(), "select id from leads where org_id = $1 and phone_e164 = $2 and deleted_at is null order by created_at desc limit 1", [org.id, from]);
  if (!lead) {
    // Someone texted the business number directly. No consent record → no automated texts; a rep is told.
    const src = await ensureSource(service(), org.id, "manual", null, "Inbound text");
    lead = await one<{ id: string }>(service(), "insert into leads (org_id, source_id, phone_e164, ai_status, ai_paused_reason, created_at) values ($1, $2, $3, 'paused', 'inbound_unknown_number', $4) returning id", [org.id, src.id, from, now()]);
    await q(service(), "insert into stage_events (org_id, lead_id, to_stage, actor, created_at) values ($1, $2, 'new', 'inbound_sms', $3)", [org.id, lead.id, now()]);
    if (org.default_owner_user_id) await notifyUser(service(), { orgId: org.id, userId: org.default_owner_user_id, leadId: lead.id, kind: "unknown_inbound", subject: "New text from an unknown number", body: `${from}: ${(params.Body ?? "").slice(0, 160)}` });
  }
  const optOutType = (params.OptOutType ?? "").toUpperCase();
  const r = await handleInbound(service(), {
    orgId: org.id, leadId: lead.id, channel: "sms", body: params.Body ?? "", providerMessageId: params.MessageSid, from,
    carrierHandledOptOut: optOutType === "STOP" || optOutType === "START" || optOutType === "HELP" ? optOutType : null,
  });
  log.info("webhook.twilio.sms", { org_id: org.id, lead_id: lead.id, action: r.action });
  return twiml();
}
