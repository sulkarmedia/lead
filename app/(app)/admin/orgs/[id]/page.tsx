// One org, platform-admin view: health, members, recent failures and the audit log. Audited.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOrgContext, audit } from "@/lib/auth";
import { q, service } from "@/lib/db";
import type { Org } from "@/lib/db/types";
import { fmtTime } from "@/lib/format";
import { Badge, Card, CardTitle, Stat } from "../../../../_components/ui";
import { orgHealth, pct } from "../../_components/health";
import { BaaForm, ImpersonateButton, StatusSelect, TextingToggle } from "../../_components/OrgControls";

export const dynamic = "force-dynamic";

export default async function AdminOrgPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await getOrgContext();
  if (!ctx.isPlatformAdmin) redirect("/inbox");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [o] = await orgHealth(id);
  if (!o) notFound();
  await audit({ user: ctx.user, isPlatformAdmin: true, membership: null, org: { id: o.id } as Org }, "admin.view_org", "organization", o.id);
  const created = (await searchParams).created === "1";

  const db = service();
  const [members, jobs, msgs, integrations, log] = await Promise.all([
    q<any>(db, "select display_name, email, role, active, mobile_phone from memberships where org_id = $1 order by role, display_name", [id]),
    q<any>(db, "select kind, last_error, attempts, finished_at, created_at, lead_id from jobs where org_id = $1 and status = 'failed' order by coalesce(finished_at, created_at) desc limit 10", [id]),
    q<any>(db, "select channel, error, created_at, lead_id from messages where org_id = $1 and status = 'failed' order by created_at desc limit 10", [id]),
    q<any>(db, "select kind, status, last_error from integrations where org_id = $1 order by kind", [id]),
    q<any>(db, "select actor, action, entity, entity_id, diff, created_at from audit_log where org_id = $1 order by created_at desc limit 30", [id]),
  ]);
  const tz = o.timezone;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/admin" className="text-xs muted">← Admin</Link>
          <h1 className="text-xl font-semibold">{o.name}</h1>
          <div className="text-sm muted">{o.slug} · {o.industry} · {tz} · created {fmtTime(o.created_at, tz, "LLL d, yyyy")}</div>
        </div>
        <ImpersonateButton orgId={o.id} />
      </div>
      {created && <div className="card border-green-500/40 bg-green-500/10 p-3 text-sm">Organization created. The owner can sign in and start the setup wizard; texting stays off until carrier registration is approved.</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Leads" value={o.leads} sub={`+${o.leads_7d} in 7 days`} />
        <Stat label="Failed jobs (24h)" value={o.failed_jobs_24h} sub={`${o.failed_msgs_24h} failed sends`} />
        <Stat label="Opt-out rate (7d)" value={pct(o.opt_outs_7d, o.contacted_7d)} sub={`${o.opt_outs_7d} of ${o.contacted_7d} contacted`} />
        <Stat label="Block rate (7d)" value={pct(o.blocked_7d, o.outbound_7d)} sub={`${o.blocked_7d} of ${o.outbound_7d} outbound`} />
      </div>

      <Card className="space-y-3">
        <CardTitle>Switches</CardTitle>
        <div className="flex flex-wrap items-center gap-3"><TextingToggle org={o} /><StatusSelect org={o} /></div>
        <BaaForm org={o} tz={tz} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Members</CardTitle>
          <ul className="space-y-1 text-sm">
            {members.map((m, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="truncate">{m.display_name} <span className="text-xs muted">{m.email}</span></span>
                <span className="flex gap-1"><Badge>{m.role}</Badge>{!m.active && <Badge tone="red">inactive</Badge>}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>Integrations</CardTitle>
          {integrations.length === 0 ? <p className="text-sm muted">None connected.</p> : (
            <ul className="space-y-1 text-sm">
              {integrations.map((i, k) => (
                <li key={k}>
                  <div className="flex justify-between"><span>{i.kind}</span><Badge tone={i.status === "connected" ? "green" : i.status === "error" ? "red" : "gray"}>{i.status}</Badge></div>
                  {i.last_error && <div className="truncate text-xs text-red-600">{i.last_error}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>Recent failed jobs</CardTitle>
          {jobs.length === 0 ? <p className="text-sm muted">None.</p> : (
            <ul className="space-y-1 text-xs">
              {jobs.map((j, k) => <li key={k}><span className="font-medium">{j.kind}</span> · {fmtTime(j.finished_at ?? j.created_at, tz)} · {j.attempts} attempts<div className="truncate text-red-600">{j.last_error}</div></li>)}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>Recent send errors</CardTitle>
          {msgs.length === 0 ? <p className="text-sm muted">None.</p> : (
            <ul className="space-y-1 text-xs">
              {msgs.map((m, k) => <li key={k}><span className="font-medium">{m.channel}</span> · {fmtTime(m.created_at, tz)}<div className="truncate text-red-600">{m.error}</div></li>)}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardTitle>Audit log</CardTitle>
        <ul className="divide-y divide-[var(--border)] text-xs">
          {log.map((a, k) => (
            <li key={k} className="py-1.5">
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{a.action}</span><span className="muted">{fmtTime(a.created_at, tz)}</span></div>
              <div className="muted">{a.actor} · {a.entity}{a.entity_id ? ` ${String(a.entity_id).slice(0, 8)}` : ""}</div>
              {a.diff && <code className="block truncate muted">{JSON.stringify(a.diff)}</code>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
