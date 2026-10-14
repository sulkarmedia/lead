// Outbound signed webhooks: JSON body, X-Leadline-Signature: sha256=<hex HMAC of body>.
import { hmacSha256Hex } from "../crypto";

export function signWebhook(secret: string, body: string, timestamp: number) {
  return `t=${timestamp},sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export async function postWebhook(url: string, secret: string, event: string, payload: unknown, at: Date) {
  const body = JSON.stringify({ event, created_at: at.toISOString(), data: payload });
  const ts = Math.floor(at.getTime() / 1000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-leadline-event": event, "x-leadline-signature": signWebhook(secret, body, ts) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}
