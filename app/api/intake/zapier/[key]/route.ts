// Zapier bridge: Facebook Lead Ads → Webhooks by Zapier POST here. The org's intake key in the URL
// authenticates the call. Keeps the Meta lead id so Conversions API feedback works before native intake.
import { after } from "next/server";
import { maybeOne, service } from "@/lib/db";
import type { Org } from "@/lib/db/types";
import { ensureSource, ingestLead } from "@/lib/leads/intake";
import { json } from "@/lib/http";
import { log } from "@/lib/log";
import { runFirstTouchNow } from "@/worker/fastpath";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const org = await maybeOne<Org>(service(), "select * from organizations where intake_key = $1", [key]);
  if (!org) return json({ error: "unknown intake key" }, 404);
  let body: Record<string, unknown>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    body = ct.includes("application/json") ? await req.json() : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const formId = (body.form_id ?? body.formId ?? null) as string | null;
  const source = await ensureSource(service(), org.id, "zapier", formId ? String(formId) : null, formId ? `Form ${formId} (Zapier)` : "Zapier intake");
  const result = await ingestLead(org.id, source.id, body, "zapier");
  log.info("webhook.zapier", { org_id: org.id, status: result.status });
  if (result.status === "rejected") return json({ ok: false, error: result.reason }, 422);
  if (result.status === "created") after(() => runFirstTouchNow(result.leadId));
  return json({ ok: true, status: result.status, lead_id: result.leadId });
}
