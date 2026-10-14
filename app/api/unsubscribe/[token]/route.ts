// RFC 8058 one-click unsubscribe (List-Unsubscribe-Post). Mail clients POST here.
import { maybeOne, service } from "@/lib/db";
import type { Lead } from "@/lib/db/types";
import { applyOptOut } from "@/lib/conversation";

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lead = await maybeOne<Lead>(service(), "select * from leads where unsubscribe_token = $1", [token]);
  if (lead && !lead.opted_out_email_at) await applyOptOut(service(), lead, "sms", "email_unsubscribe", { viaChannel: "email" });
  return new Response("Unsubscribed", { status: 200 });
}
