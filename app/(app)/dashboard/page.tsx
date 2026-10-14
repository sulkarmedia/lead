// Owner dashboard: speed to lead and funnel rates for agent-arm leads, split by form, campaign, ad
// and rep; AI- vs human-handled; agent vs control (the pilot's split); cost per appointment by
// campaign once ad spend rows exist. All SQL lives in lib/metrics.ts.
import { DateTime } from "luxon";
import { requireAdmin } from "@/lib/auth";
import { withUserDb } from "@/lib/db";
import { now } from "@/lib/clock";
import { dashboard } from "@/lib/metrics";
import { Button, ButtonLink, Card, CardTitle, Input, PageHeader, Stat } from "../../_components/ui";
import { MetricsTable, RateCell, fmtDuration, pct } from "./_components/MetricsTable";

export const dynamic = "force-dynamic";

const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireAdmin();
  const tz = ctx.org.timezone;
  const today = DateTime.fromJSDate(now(), { zone: tz }).startOf("day");
  let toDay = isDate(sp.to) ? DateTime.fromISO(sp.to!, { zone: tz }) : today;
  if (!toDay.isValid) toDay = today;
  let fromDay = isDate(sp.from) ? DateTime.fromISO(sp.from!, { zone: tz }) : toDay.minus({ days: 29 });
  if (!fromDay.isValid || fromDay > toDay) fromDay = toDay.minus({ days: 29 });
  const range = { from: fromDay.startOf("day").toJSDate(), to: toDay.plus({ days: 1 }).startOf("day").toJSDate() };
  const d = await withUserDb(ctx.user.id, (c) => dashboard(c, ctx.org.id, range));
  const s = d.summary;
  const [agent, control] = d.arms;
  const preset = (days: number) => `/dashboard?from=${today.minus({ days: days - 1 }).toISODate()}&to=${today.toISODate()}`;
  const handlerLabel = (k: string) => (k === "ai" ? "AI-handled" : "Human-handled");

  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard">
        {fromDay.toFormat("LLL d")} – {toDay.toFormat("LLL d, yyyy")} · leads created in range · agent arm{control.leads > 0 ? " (control excluded)" : ""}
      </PageHeader>

      <form method="get" className="card flex flex-wrap items-end gap-2 p-3" data-testid="dashboard-range">
        <label className="text-xs muted">From<Input type="date" name="from" defaultValue={fromDay.toISODate()!} className="mt-1 w-40" /></label>
        <label className="text-xs muted">To<Input type="date" name="to" defaultValue={toDay.toISODate()!} className="mt-1 w-40" /></label>
        <Button type="submit">Apply</Button>
        <div className="flex gap-1">
          <ButtonLink variant="ghost" href={preset(7)}>7d</ButtonLink>
          <ButtonLink variant="ghost" href={preset(30)}>30d</ButtonLink>
          <ButtonLink variant="ghost" href={preset(90)}>90d</ButtonLink>
        </div>
      </form>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="dashboard-stats">
        <Stat label="Median speed to lead" value={fmtDuration(s.medianSpeedSec)} sub={`${s.contacted} of ${s.leads} contacted`} />
        <Stat label="Reply rate" value={pct(s.replyRate)} sub={`${s.replied} replied`} />
        <Stat label="Qualified rate" value={pct(s.qualifiedRate)} sub={`${s.qualified} qualified`} />
        <Stat label="Appointment rate" value={pct(s.appointmentRate)} sub={`${s.appointments} appointments`} />
        <Stat label="Show rate" value={pct(s.showRate)} sub={`${s.showed} showed`} />
        <Stat label="Sold" value={s.sold} sub={pct(s.soldRate) + " of leads"} />
      </div>

      <Card className="p-0" data-testid="arm-comparison">
        <CardTitle className="px-4 pt-4">Agent vs control</CardTitle>
        <p className="px-4 text-xs muted">
          The pilot sends {ctx.org.agent_split_percent}% of new leads to the agent; the rest are the control arm, worked by reps only.
          {control.leads === 0 && " No control-arm leads in this range."}
        </p>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead className="border-b border-app text-left text-xs muted">
              <tr>
                <th className="px-3 py-2 font-medium">Arm</th>
                <th className="px-3 py-2 text-right font-medium">Leads</th>
                <th className="px-3 py-2 font-medium">Reply</th>
                <th className="px-3 py-2 font-medium">Appt</th>
                <th className="px-3 py-2 font-medium">Show</th>
                <th className="px-3 py-2 font-medium">Sold</th>
              </tr>
            </thead>
            <tbody>
              {[agent, control].map((r) => (
                <tr key={r.key} className="border-b border-app last:border-0">
                  <td className="px-3 py-2 font-medium">{r.key === "agent" ? "Agent" : "Control"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.leads}</td>
                  <RateCell value={r.replyRate} label="Reply rate" />
                  <RateCell value={r.appointmentRate} label="Appointment rate" />
                  <RateCell value={r.showRate} label="Show rate" />
                  <RateCell value={r.soldRate} label="Sold rate" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <MetricsTable title="AI-handled vs human-handled" keyLabel="Handled by" rows={d.byHandler} labelFor={handlerLabel} testId="by-handler" />
      <p className="-mt-2 text-xs muted">A lead is human-handled once a rep has sent it any message.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <MetricsTable title="By form" keyLabel="Form" rows={d.byForm} testId="by-form" />
        <MetricsTable title="By rep" keyLabel="Rep" rows={d.byRep} testId="by-rep" />
        <MetricsTable title="By campaign" keyLabel="Campaign" rows={d.byCampaign} testId="by-campaign" />
        <MetricsTable title="By ad" keyLabel="Ad" rows={d.byAd} testId="by-ad" />
      </div>

      <Card className="p-0" data-testid="cost-per-appointment">
        <CardTitle className="px-4 pt-4">Cost per appointment by campaign</CardTitle>
        {d.cost.length === 0 ? (
          <div className="px-4 pb-4 text-sm muted">No ad spend in this range yet. Spend is pulled from Meta once the ad account is connected.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-app text-left text-xs muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">Appointments</th>
                  <th className="px-3 py-2 text-right font-medium">Cost / appt</th>
                </tr>
              </thead>
              <tbody>
                {d.cost.map((r) => (
                  <tr key={r.campaignId} className="border-b border-app last:border-0">
                    <td className="max-w-64 truncate px-3 py-2 font-medium">{r.campaignName ?? r.campaignId}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.spend)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.appointments}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.costPerAppointment === null ? "—" : money(r.costPerAppointment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
