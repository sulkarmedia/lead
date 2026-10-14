// Email unsubscribe link target. One-click POST (RFC 8058) is handled by route.ts in ./one-click.
import { maybeOne, service } from "@/lib/db";
import type { Lead, Org } from "@/lib/db/types";
import { applyOptOut } from "@/lib/conversation";

export const dynamic = "force-dynamic";

export default async function Unsubscribe({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const lead = await maybeOne<Lead>(service(), "select * from leads where unsubscribe_token = $1", [token]);
  const org = lead ? await maybeOne<Org>(service(), "select name from organizations where id = $1", [lead.org_id]) : null;
  async function confirm() {
    "use server";
    const l = await maybeOne<Lead>(service(), "select * from leads where unsubscribe_token = $1", [token]);
    if (l && !l.opted_out_email_at) await applyOptOut(service(), l, "sms", "email_unsubscribe", { viaChannel: "email" });
  }
  const done = !!lead?.opted_out_email_at || (await searchParams).done;
  return (
    <main className="mx-auto max-w-md p-8 text-center">
      {!lead ? (
        <p>This link is no longer valid.</p>
      ) : done ? (
        <p>You&apos;re unsubscribed from {org?.name} emails.</p>
      ) : (
        <form action={confirm}>
          <p className="mb-4">Unsubscribe from emails from {org?.name}?</p>
          <button className="rounded-lg bg-brand px-4 py-2 text-brand-fg">Unsubscribe</button>
        </form>
      )}
    </main>
  );
}
