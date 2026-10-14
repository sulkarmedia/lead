// Twilio Programmable Messaging over REST (two endpoints; no SDK). Docs:
// https://www.twilio.com/docs/messaging/api/message-resource and
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
import { createHmac } from "node:crypto";
import { safeEqual } from "../crypto";
import { env } from "../env";

export interface TwilioSendInput {
  to: string;
  body: string;
  from?: string | null;
  messagingServiceSid?: string | null;
  statusCallback?: string;
  accountSid?: string; // tenant subaccount (phase 5)
}

export async function twilioSend(i: TwilioSendInput): Promise<{ sid: string; status: string }> {
  const sid = i.accountSid ?? env.twilioAccountSid;
  const token = env.twilioAuthToken;
  if (!sid || !token) throw new Error("Twilio credentials are not configured");
  const form = new URLSearchParams({ To: i.to, Body: i.body });
  if (i.messagingServiceSid) form.set("MessagingServiceSid", i.messagingServiceSid);
  else if (i.from) form.set("From", i.from);
  else throw new Error("no From number or Messaging Service");
  if (i.statusCallback) form.set("StatusCallback", i.statusCallback);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${env.twilioAccountSid}:${token}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
  if (!res.ok || !json.sid) throw new Error(`twilio ${res.status}: ${json.code ?? ""} ${json.message ?? ""}`.trim());
  return { sid: json.sid, status: json.status ?? "queued" };
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioSignature(authToken: string | undefined, url: string, params: Record<string, string>, header: string | null): boolean {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, params), header);
}
