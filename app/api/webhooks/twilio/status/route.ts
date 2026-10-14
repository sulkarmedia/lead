// Delivery status callbacks: sent → delivered / failed / undelivered.
import { q, service } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyTwilioSignature } from "@/lib/integrations/twilio";
import { publicUrl } from "@/lib/http";
import { log } from "@/lib/log";
import { now } from "@/lib/clock";

export async function POST(req: Request) {
  const params = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
  if (!verifyTwilioSignature(env.twilioAuthToken, publicUrl(req), params, req.headers.get("x-twilio-signature"))) return new Response("forbidden", { status: 403 });
  const status = params.MessageStatus;
  const sid = params.MessageSid;
  if (status === "delivered") await q(service(), "update messages set status = 'delivered', delivered_at = $2 where provider_message_id = $1", [sid, now()]);
  else if (status === "failed" || status === "undelivered") {
    const rows = await q<{ org_id: string; lead_id: string }>(service(), "update messages set status = 'failed', error = $2 where provider_message_id = $1 returning org_id, lead_id", [sid, `${status} ${params.ErrorCode ?? ""}`.trim()]);
    // 21610: recipient replied STOP at the carrier level — treat as an opt-out we must honor.
    if (params.ErrorCode === "21610" && rows[0]) await q(service(), "update leads set opted_out_sms_at = coalesce(opted_out_sms_at, $2) where id = $1", [rows[0].lead_id, now()]);
    log.warn("twilio.delivery_failed", { org_id: rows[0]?.org_id, sid, status, code: params.ErrorCode });
  }
  return new Response(null, { status: 204 });
}
