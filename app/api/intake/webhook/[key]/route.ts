// Generic signed webhook intake: header X-Leadline-Signature: sha256=<hex HMAC(intake_key, raw body)>.
import { after } from "next/server";
import { maybeOne, service } from "@/lib/db";
import type { Org } from "@/lib/db/types";
import { hmacSha256Hex, safeEqual } from "@/lib/crypto";
import { ensureSource, ingestLead } from "@/lib/leads/intake";
import { json } from "@/lib/http";
import { runFirstTouchNow } from "@/worker/fastpath";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const org = await maybeOne<Org>(service(), "select * from organizations where slug = $1", [key]);
  if (!org) return json({ error: "not found" }, 404);
  const raw = await req.text();
  const sig = req.headers.get("x-leadline-signature") ?? "";
  if (!safeEqual(sig, `sha256=${hmacSha256Hex(org.intake_key, raw)}`)) return json({ error: "bad signature" }, 401);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400); }
  const source = await ensureSource(service(), org.id, "webhook", null, "Webhook intake");
  const r = await ingestLead(org.id, source.id, body, "webhook");
  if (r.status === "rejected") return json({ ok: false, error: r.reason }, 422);
  if (r.status === "created") after(() => runFirstTouchNow(r.leadId));
  return json({ ok: true, status: r.status, lead_id: r.leadId });
}
