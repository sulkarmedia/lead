// Postmark email over REST. Docs: https://postmarkapp.com/developer/api/email-api and
// https://postmarkapp.com/developer/webhooks/inbound-webhook
import { z } from "zod";
import { env } from "../env";
import { safeEqual } from "../crypto";

export interface EmailSendInput {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  /** "outbound" (transactional) or the broadcast stream for cadence/marketing-style mail. */
  stream: "transactional" | "broadcast";
}

export function streamId(kind: EmailSendInput["stream"]) {
  return kind === "broadcast" ? process.env.POSTMARK_BROADCAST_STREAM ?? "broadcast" : process.env.POSTMARK_TRANSACTIONAL_STREAM ?? "outbound";
}

export async function postmarkSend(i: EmailSendInput): Promise<{ messageId: string }> {
  const token = env.postmarkServerToken;
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN is not set");
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({
      From: i.from,
      To: i.to,
      ReplyTo: i.replyTo,
      Subject: i.subject,
      TextBody: i.text,
      HtmlBody: i.html,
      Headers: Object.entries(i.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      MessageStream: streamId(i.stream),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
  if (!res.ok || json.ErrorCode || !json.MessageID) throw new Error(`postmark ${res.status}: ${json.ErrorCode ?? ""} ${json.Message ?? ""}`.trim());
  return { messageId: json.MessageID };
}

export const PostmarkInbound = z.object({
  From: z.string(),
  FromFull: z.object({ Email: z.string(), Name: z.string().optional() }).optional(),
  To: z.string().optional(),
  ToFull: z.array(z.object({ Email: z.string(), MailboxHash: z.string().optional() })).optional(),
  OriginalRecipient: z.string().optional(),
  MailboxHash: z.string().optional(),
  Subject: z.string().optional().default(""),
  TextBody: z.string().optional().default(""),
  StrippedTextReply: z.string().optional().default(""),
  MessageID: z.string(),
});
export type PostmarkInbound = z.infer<typeof PostmarkInbound>;

/** Pull the per-lead reply token out of lead-<token>@<inbound domain>. */
export function replyTokenFrom(p: PostmarkInbound): string | null {
  const candidates = [p.OriginalRecipient, p.To, ...(p.ToFull ?? []).map((t) => t.Email)].filter(Boolean) as string[];
  for (const c of candidates) {
    const m = /lead-([a-f0-9]{24})@/i.exec(c);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Postmark doesn't sign inbound webhooks; the URL carries a shared secret (basic auth or ?token=). */
export function verifyPostmarkInbound(req: { url: string; authorization: string | null }): boolean {
  const secret = env.postmarkInboundWebhookSecret;
  if (!secret) return false;
  const token = new URL(req.url).searchParams.get("token");
  if (token && safeEqual(token, secret)) return true;
  if (req.authorization?.startsWith("Basic ")) {
    const [, pass] = Buffer.from(req.authorization.slice(6), "base64").toString().split(":");
    if (pass && safeEqual(pass, secret)) return true;
  }
  return false;
}
