// Meta leadgen webhooks: GET verification handshake, POST events signed with X-Hub-Signature-256.
import { after } from "next/server";
import { service } from "@/lib/db";
import { env } from "@/lib/env";
import { LeadgenWebhook, verifyMetaSignature } from "@/lib/integrations/meta";
import { ingestMetaLead } from "@/lib/integrations/meta-sync";
import { log } from "@/lib/log";
import { runFirstTouchNow } from "@/worker/fastpath";

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("hub.mode") === "subscribe" && env.metaWebhookVerifyToken && u.searchParams.get("hub.verify_token") === env.metaWebhookVerifyToken) {
    return new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) return new Response("forbidden", { status: 403 });
  const parsed = LeadgenWebhook.safeParse(JSON.parse(raw));
  if (!parsed.success) return new Response("ok"); // other subscribed fields
  // Acknowledge fast; fetch leads after responding.
  after(async () => {
    for (const entry of parsed.data.entry) {
      for (const ch of entry.changes) {
        if (ch.field !== "leadgen") continue;
        try {
          const r = await ingestMetaLead(service(), ch.value.leadgen_id, ch.value.page_id, ch.value.form_id);
          if (r && "leadId" in r && r.status === "created") await runFirstTouchNow(r.leadId);
        } catch (e) {
          log.error("webhook.meta.ingest_failed", { leadgen_id: ch.value.leadgen_id, page_id: ch.value.page_id, error: (e as Error).message });
        }
      }
    }
  });
  return new Response("ok");
}
