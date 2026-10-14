// Stripe (phase 5). Verifies Stripe-Signature (t=..., v1=HMAC-SHA256(secret, `${t}.${body}`)) and
// records subscription state on the org. Going live requires an active subscription once enabled.
import { createHmac } from "node:crypto";
import { q, service } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";
import { json } from "@/lib/http";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "stripe not configured" }, 503);
  const raw = await req.text();
  const header = req.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  if (!parts.v1 || !safeEqual(parts.v1, expected) || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw) as { type: string; data: { object: { metadata?: { org_id?: string }; status?: string; id?: string } } };
  const obj = event.data.object;
  if (event.type.startsWith("customer.subscription.") && obj.metadata?.org_id) {
    await q(service(), `update organizations set onboarding_progress = onboarding_progress || jsonb_build_object('stripe_subscription_status', $2::text, 'stripe_subscription_id', $3::text) where id = $1`,
      [obj.metadata.org_id, obj.status ?? "unknown", obj.id ?? null]);
  }
  return json({ received: true });
}
