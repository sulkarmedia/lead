// Platform owner console: every org with health (failed jobs, send errors, opt-out and block rates),
// worker heartbeat, managed-onboarding org creation, texting/BAA switches and audited impersonation.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrgContext, audit } from "@/lib/auth";
import { env } from "@/lib/env";
import { Badge, Button, Card, CardTitle, Empty, Input, Label, PageHeader, Stat, cx } from "../../_components/ui";
import { createOrgAction } from "../../_actions/admin";
import { fmtAge, orgHealth, pct, workerHeartbeat } from "./_components/health";
import { BaaForm, ImpersonateButton, StatusSelect, TextingToggle } from "./_components/OrgControls";

export const dynamic = "force-dynamic";

const STATUS_TONE = { live: "green", onboarding: "blue", paused: "yellow" } as const;

export default async function AdminPage() {
  const ctx = await getOrgContext();
  if (!ctx.isPlatformAdmin) redirect("/inbox");
  const [orgs, hb] = await Promise.all([orgHealth(), workerHeartbeat()]);
  await audit({ ...ctx, membership: null }, "admin.view_orgs", "platform", null, { orgs: orgs.length });

  const totals = orgs.reduce((t, o) => ({ failedJobs: t.failedJobs + o.failed_jobs_24h, failedMsgs: t.failedMsgs + o.failed_msgs_24h, leads7: t.leads7 + o.leads_7d }), { failedJobs: 0, failedMsgs: 0, leads7: 0 });
  const hbStale = !hb || hb.ageSeconds > Math.max(120, env.workerPollSeconds * 4);

  return (
    <div className="space-y-6">
      <PageHeader title="Platform admin">Every org on the platform. Views and changes here are written to each org&apos;s audit log.</PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Organizations" value={orgs.length} sub={`${orgs.filter((o) => o.status === "live").length} live · ${orgs.filter((o) => o.texting_enabled).length} texting`} />
        <Stat label="Worker heartbeat" value={<span className={cx(hbStale && "text-red-600")} data-testid="heartbeat">{hb ? `${fmtAge(hb.ageSeconds)} ago` : "never"}</span>} sub={hb?.worker ?? "no worker has run"} />
        <Stat label="Failed jobs (24h)" value={<span className={cx(totals.failedJobs > 0 && "text-red-600")}>{totals.failedJobs}</span>} sub={`${totals.failedMsgs} failed sends`} />
        <Stat label="New leads (7d)" value={totals.leads7} sub={env.dryRun ? "DRY RUN is on" : "live sending"} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Organizations</h2>
        {orgs.length === 0 ? <Empty>No organizations yet.</Empty> : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="card w-full text-left text-sm" data-testid="admin-orgs">
                <thead className="text-xs muted">
                  <tr className="border-b border-app">
                    <th className="p-2">Org</th><th className="p-2">Status</th><th className="p-2 text-right">Leads</th>
                    <th className="p-2 text-right">Failed jobs 24h</th><th className="p-2 text-right">Send errors 24h</th>
                    <th className="p-2 text-right">Opt-out 7d</th><th className="p-2 text-right">Blocked 7d</th><th className="p-2">Texting</th><th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id} className="border-b border-app last:border-0 align-top">
                      <td className="p-2">
                        <Link href={`/admin/orgs/${o.id}`} className="font-medium hover:underline">{o.name}</Link>
                        <div className="text-xs muted">{o.slug} · {o.industry} · {o.members} members</div>
                      </td>
                      <td className="p-2"><Badge tone={STATUS_TONE[o.status as keyof typeof STATUS_TONE] ?? "gray"}>{o.status}</Badge></td>
                      <td className="p-2 text-right tabular-nums">{o.leads}<div className="text-xs muted">+{o.leads_7d} 7d</div></td>
                      <td className={cx("p-2 text-right tabular-nums", o.failed_jobs_24h > 0 && "text-red-600")}>{o.failed_jobs_24h}</td>
                      <td className={cx("p-2 text-right tabular-nums", (o.failed_msgs_24h > 0 || o.integration_errors > 0) && "text-red-600")}>
                        {o.failed_msgs_24h}{o.integration_errors > 0 && <div className="text-xs">{o.integration_errors} integration error{o.integration_errors === 1 ? "" : "s"}</div>}
                      </td>
                      <td className="p-2 text-right tabular-nums">{pct(o.opt_outs_7d, o.contacted_7d)}<div className="text-xs muted">{o.opt_outs_7d}/{o.contacted_7d}</div></td>
                      <td className="p-2 text-right tabular-nums">{pct(o.blocked_7d, o.outbound_7d)}<div className="text-xs muted">{o.blocked_7d}/{o.outbound_7d}</div></td>
                      <td className="p-2"><TextingToggle org={o} /></td>
                      <td className="p-2"><ImpersonateButton orgId={o.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 lg:hidden">
              {orgs.map((o) => (
                <li key={o.id} className="card space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/admin/orgs/${o.id}`} className="font-medium">{o.name}</Link>
                      <div className="text-xs muted">{o.slug} · {o.industry}</div>
                    </div>
                    <Badge tone={STATUS_TONE[o.status as keyof typeof STATUS_TONE] ?? "gray"}>{o.status}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <span className="muted">Leads</span><span className="text-right">{o.leads} (+{o.leads_7d} 7d)</span>
                    <span className="muted">Failed jobs 24h</span><span className={cx("text-right", o.failed_jobs_24h > 0 && "text-red-600")}>{o.failed_jobs_24h}</span>
                    <span className="muted">Send errors 24h</span><span className={cx("text-right", o.failed_msgs_24h > 0 && "text-red-600")}>{o.failed_msgs_24h}</span>
                    <span className="muted">Opt-out rate 7d</span><span className="text-right">{pct(o.opt_outs_7d, o.contacted_7d)}</span>
                    <span className="muted">Block rate 7d</span><span className="text-right">{pct(o.blocked_7d, o.outbound_7d)}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2"><TextingToggle org={o} /><ImpersonateButton orgId={o.id} /></div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Create organization (managed onboarding)</CardTitle>
          <form action={createOrgAction} className="space-y-3" data-testid="admin-create-org">
            <Label>Business name<Input name="name" required placeholder="Lakeside Honda" /></Label>
            <div className="grid grid-cols-2 gap-2">
              <Label hint="lowercase, dashes">Slug<Input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,40}" placeholder="lakeside-honda" /></Label>
              <Label>Industry<Input name="industry" required defaultValue="automotive" list="industries" /></Label>
            </div>
            <datalist id="industries">
              {["automotive", "home_services", "real_estate", "insurance", "med_spa", "dental", "plastic_surgery", "legal"].map((i) => <option key={i} value={i} />)}
            </datalist>
            <Label>Time zone<Input name="timezone" required defaultValue="America/Chicago" list="timezones" /></Label>
            <datalist id="timezones">
              {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((t) => <option key={t} value={t} />)}
            </datalist>
            <div className="grid grid-cols-2 gap-2">
              <Label hint={env.devLogin || !env.supabaseUrl ? "Local: user is created directly" : "Gets a Supabase invite email"}>Owner email<Input name="owner_email" type="email" required /></Label>
              <Label>Owner name<Input name="owner_name" placeholder="optional" /></Label>
            </div>
            <p className="text-xs muted">New orgs start in onboarding with texting off. Turn texting on only after carrier registration is approved.</p>
            <Button>Create organization</Button>
          </form>
        </Card>

        <Card>
          <CardTitle>Compliance switches</CardTitle>
          <p className="mb-3 text-xs muted">Texting reflects carrier registration approval. Medical orgs also need HIPAA BAAs with every vendor before they can go live.</p>
          {orgs.length === 0 ? <p className="text-sm muted">No orgs.</p> : (
            <ul className="space-y-3">
              {orgs.map((o) => (
                <li key={o.id} className="space-y-1.5 border-b border-app pb-3 last:border-0">
                  <div className="text-sm font-medium">{o.name}</div>
                  <div className="flex flex-wrap items-center gap-3"><TextingToggle org={o} /><StatusSelect org={o} /></div>
                  <BaaForm org={o} tz={o.timezone} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
