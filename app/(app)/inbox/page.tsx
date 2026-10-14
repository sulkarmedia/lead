// Needs-attention queue: handoffs waiting on a rep (with SLA timer), new replies on paused threads,
// messages awaiting approval, failed sends. Default page on mobile.
import Link from "next/link";
import { getOrgContext } from "@/lib/auth";
import { q, withUserDb } from "@/lib/db";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { ago, fmtTime } from "@/lib/format";
import { Badge, Button, Empty, PageHeader, STAGE_TONE, stageLabel, Textarea } from "../../_components/ui";
import { LiveRefresh } from "../../_components/LiveRefresh";
import { approveAction, rejectAction, retryAction } from "../../_actions/leads";

export const dynamic = "force-dynamic";

export default async function Inbox({ searchParams }: { searchParams: Promise<{ mine?: string }> }) {
  const ctx = await getOrgContext();
  const mine = (await searchParams).mine === "1" || ctx.role === "rep";
  const data = await withUserDb(ctx.user.id, async (c) => {
    const scope = mine ? "and (l.assigned_user_id = $2 or l.assigned_user_id is null)" : "";
    const params = mine ? [ctx.org.id, ctx.user.id] : [ctx.org.id];
    const handoffs = await q<any>(c, `select l.*, (select body from messages m where m.lead_id = l.id and m.author = 'lead' order by created_at desc limit 1) as last_body,
                                         (select max(created_at) from messages m where m.lead_id = l.id and m.author = 'user') as last_rep_at
                                    from leads l where l.org_id = $1 and l.ai_status = 'paused' ${scope}
                                     and (l.handoff_at is not null or l.last_inbound_at > coalesce((select max(created_at) from messages m where m.lead_id = l.id and m.author = 'user'), 'epoch'))
                                   order by coalesce(l.handoff_at, l.last_inbound_at) asc limit 50`, params);
    const approvals = await q<any>(c, `select m.*, l.full_name, l.stage, l.phone_e164 from messages m join leads l on l.id = m.lead_id
                                        where m.org_id = $1 and m.status = 'pending_approval' ${scope} order by m.created_at limit 50`, params);
    const failed = await q<any>(c, `select m.*, l.full_name from messages m join leads l on l.id = m.lead_id
                                     where m.org_id = $1 and m.status = 'failed' ${scope} order by m.created_at desc limit 20`, params);
    const members = await q<{ user_id: string; display_name: string }>(c, "select user_id, display_name from memberships where org_id = $1", [ctx.org.id]);
    return { handoffs, approvals, failed, members };
  });
  const rep = (id: string | null) => data.members.find((m) => m.user_id === id)?.display_name ?? "Unassigned";
  const at = now();
  const total = data.handoffs.length + data.approvals.length + data.failed.length;
  return (
    <div className="space-y-6">
      <LiveRefresh orgId={ctx.org.id} tables={["messages", "leads"]} supabaseUrl={env.devLogin ? null : env.supabaseUrl} anonKey={env.devLogin ? null : env.supabaseAnonKey} />
      <PageHeader title="Inbox" actions={ctx.role !== "rep" && <Link className="text-sm underline" href={mine ? "/inbox" : "/inbox?mine=1"}>{mine ? "Show everyone's" : "Only mine"}</Link>}>
        {total === 0 ? "Nothing needs you right now." : `${total} item${total === 1 ? "" : "s"} need attention`}
      </PageHeader>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Waiting on a rep</h2>
        {data.handoffs.length === 0 ? <Empty>No handoffs waiting.</Empty> : (
          <ul className="space-y-2">
            {data.handoffs.map((l) => {
              const waitingMin = l.handoff_at ? Math.round((at.getTime() - new Date(l.handoff_at).getTime()) / 60000) : null;
              const replied = l.last_rep_at && l.handoff_at && new Date(l.last_rep_at) > new Date(l.handoff_at);
              return (
                <li key={l.id}>
                  <Link href={`/leads/${l.id}`} className="card block p-3 hover:opacity-90" data-testid="handoff-item">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{l.full_name ?? l.phone_e164}</div>
                      {waitingMin !== null && !replied && <Badge tone={waitingMin >= 10 ? "red" : "yellow"}>SLA {waitingMin}m / 10m</Badge>}
                      {replied && <Badge tone="blue">New reply</Badge>}
                    </div>
                    <div className="mt-1 text-xs muted">{l.ai_paused_reason?.replace("handoff: ", "") ?? "paused"} · {rep(l.assigned_user_id)} · <Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge></div>
                    {l.last_body && <div className="mt-2 line-clamp-2 text-sm">“{l.last_body}”</div>}
                    {l.summary && <div className="mt-1 line-clamp-3 whitespace-pre-line text-xs muted">{l.summary}</div>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Awaiting approval</h2>
        {data.approvals.length === 0 ? <Empty>No AI messages waiting for approval.</Empty> : (
          <ul className="space-y-2">
            {data.approvals.map((m) => (
              <li key={m.id} className="card p-3" data-testid="approval-item">
                <div className="flex items-center justify-between text-sm">
                  <Link href={`/leads/${m.lead_id}`} className="font-medium underline-offset-2 hover:underline">{m.full_name ?? m.phone_e164}</Link>
                  <span className="text-xs muted">{m.channel.toUpperCase()} · {m.purpose} · {ago(m.created_at, at)}</span>
                </div>
                <form className="mt-2 space-y-2">
                  <input type="hidden" name="message_id" value={m.id} />
                  <Textarea name="body" defaultValue={m.body} rows={3} />
                  <div className="flex gap-2">
                    <Button formAction={approveAction}>Approve &amp; send</Button>
                    <Button formAction={rejectAction} variant="secondary">Reject</Button>
                  </div>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.failed.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Failed sends</h2>
          <ul className="space-y-2">
            {data.failed.map((m) => (
              <li key={m.id} className="card flex items-center justify-between gap-2 p-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/leads/${m.lead_id}`} className="font-medium">{m.full_name}</Link>
                  <div className="truncate text-xs muted">{m.channel} · {fmtTime(m.created_at, ctx.org.timezone)} · {m.error}</div>
                </div>
                <form action={retryAction}><input type="hidden" name="message_id" value={m.id} /><Button variant="secondary">Retry</Button></form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
