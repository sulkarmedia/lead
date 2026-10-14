// Phase 5: per-tenant Twilio subaccount, local number purchase by area code, Messaging Service with
// our inbound/status webhooks. Carrier registration (Trust Hub customer profile → A2P brand →
// campaign) is NOT automated yet: the docs host was unreachable when this was written, and the spec
// requires reading current docs first. Until then a platform admin submits registration in the
// Twilio console using the details collected in onboarding and flips texting_enabled on approval.
// Endpoints: https://www.twilio.com/docs/iam/api/subaccounts, .../phone-numbers/api/availablephonenumberlocal-resource,
// .../phone-numbers/api/incomingphonenumber-resource, .../messaging/api/service-resource
import { env } from "../env";

const BASE = "https://api.twilio.com/2010-04-01";
const MSG = "https://messaging.twilio.com/v1";

function auth(sid = env.twilioAccountSid, token = env.twilioAuthToken) {
  if (!sid || !token) throw new Error("Twilio credentials are not configured");
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

async function call<T>(url: string, init: { method?: string; form?: Record<string, string>; authHeader?: string } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers: { authorization: init.authHeader ?? auth(), ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: init.form ? new URLSearchParams(init.form) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`twilio ${res.status}: ${json.code ?? ""} ${json.message ?? ""}`.trim());
  return json as T;
}

export async function createSubaccount(friendlyName: string) {
  return call<{ sid: string; auth_token: string }>(`${BASE}/Accounts.json`, { form: { FriendlyName: friendlyName } });
}

export async function searchLocalNumbers(areaCode: string, accountSid = env.twilioAccountSid!) {
  const r = await call<{ available_phone_numbers: Array<{ phone_number: string; locality: string; region: string }> }>(
    `${BASE}/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json?${new URLSearchParams({ AreaCode: areaCode, SmsEnabled: "true", PageSize: "10" })}`);
  return r.available_phone_numbers;
}

export async function purchaseNumber(phoneNumber: string, accountSid = env.twilioAccountSid!) {
  return call<{ sid: string; phone_number: string }>(`${BASE}/Accounts/${accountSid}/IncomingPhoneNumbers.json`, { form: { PhoneNumber: phoneNumber } });
}

/** Messaging Service with our webhooks; Advanced Opt-Out is configured on the service in the console. */
export async function createMessagingService(friendlyName: string, phoneNumberSid: string) {
  const svc = await call<{ sid: string }>(`${MSG}/Services`, {
    form: {
      FriendlyName: friendlyName,
      InboundRequestUrl: `${env.appUrl}/api/webhooks/twilio/sms`,
      StatusCallback: `${env.appUrl}/api/webhooks/twilio/status`,
      UseInboundWebhookOnNumber: "false",
    },
  });
  await call(`${MSG}/Services/${svc.sid}/PhoneNumbers`, { form: { PhoneNumberSid: phoneNumberSid } });
  return svc;
}
