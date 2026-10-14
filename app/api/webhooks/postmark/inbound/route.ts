// Inbound email replies. Matches lead-<token>@<inbound domain> to the lead; uses the stripped reply.
import { maybeOne, service } from "@/lib/db";
import { PostmarkInbound, replyTokenFrom, verifyPostmarkInbound } from "@/lib/integrations/postmark";
import { handleInbound } from "@/lib/conversation";
import { json } from "@/lib/http";
import { log } from "@/lib/log";

export async function POST(req: Request) {
  if (!verifyPostmarkInbound({ url: req.url, authorization: req.headers.get("authorization") })) return json({ error: "forbidden" }, 403);
  const parsed = PostmarkInbound.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid payload" }, 400);
  const p = parsed.data;
  const token = replyTokenFrom(p);
  const lead = token ? await maybeOne<{ id: string; org_id: string }>(service(), "select id, org_id from leads where email_reply_token = $1", [token]) : null;
  if (!lead) {
    log.warn("webhook.postmark.unmatched", { to: p.To });
    return json({ ok: true, matched: false }); // 200 so Postmark doesn't retry forever
  }
  const body = (p.StrippedTextReply || p.TextBody || "").trim();
  const r = await handleInbound(service(), { orgId: lead.org_id, leadId: lead.id, channel: "email", body, subject: p.Subject, providerMessageId: p.MessageID, from: p.FromFull?.Email ?? p.From });
  log.info("webhook.postmark.inbound", { org_id: lead.org_id, lead_id: lead.id, action: r.action });
  return json({ ok: true });
}
