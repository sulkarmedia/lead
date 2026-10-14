// Simulator (dry-run only): create fake leads through the real intake path, chat as them in a phone
// mockup, review/approve the agent's drafts, and fast-forward the cadence with the simulation clock.
import Link from "next/link";
import { DateTime } from "luxon";
import { getOrgContext } from "@/lib/auth";
import { maybeOne, q, service, withUserDb } from "@/lib/db";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { fmtPhone, fmtTime } from "@/lib/format";
import { getClockOffset, SIMULATED_SQL } from "@/lib/simulator";
import { refreshClock } from "@/worker/index";
import { Badge, Card, CardTitle, Empty, Input, Label, PageHeader, Select, STAGE_TONE, Stat, Textarea, cx, stageLabel } from "../../_components/ui";
import { LiveRefresh } from "../../_components/LiveRefresh";
import { advanceDayAction, createFakeLeadAction, resetClockAction, resetSimLeadsAction, runNowAction } from "../../_actions/simulator";
import { PhoneMockup, type SimMessage } from "./_components/PhoneMockup";
import { SubmitButton } from "./_components/SubmitButton";

export const dynamic = "force-dynamic";

const REVIEW_TARGET = 20;

function fmtOffset(ms: number) {
  if (!ms) return "none (real time)";
  const d = Math.floor(ms / 86400_000);
  const h = Math.floor((ms % 86400_000) / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `+${[d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ") || "0s"}`;
}

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const ctx = await getOrgContext();
  const dry = env.dryRun;
  if (dry) await refreshClock(); // keep this web process on the shared simulation clock
  const at = now();
  const tz = ctx.org.timezone;
  const offsetMs = dry ? await getClockOffset(service()) : 0;
  const wanted = (await searchParams).lead;

  const data = await withUserDb(ctx.user.id, async (c) => {
    const sources = await q<{ id: string; name: string; kind: string; consent_verified_at: Date | null; consent_covers_automated: boolean }>(
      c, "select id, name, kind, consent_verified_at, consent_covers_automated from lead_sources where org_id = $1 order by created_at", [ctx.org.id]);
    const leads = await q<any>(c, `select l.id, l.full_name, l.phone_e164, l.stage, l.ai_status, l.ai_paused_reason, l.split_arm, l.created_at, l.timezone,
                                          (select count(*)::int from messages m where m.lead_id = l.id and m.direction = 'inbound') as inbound,
                                          (select count(*)::int from messages m where m.lead_id = l.id and m.status = 'pending_approval') as pending,
                                          (select count(*)::int from messages m where m.lead_id = l.id and m.status = 'blocked') as blocked
                                     from leads l where l.org_id = $1 and l.deleted_at is null and ${SIMULATED_SQL}
                                    order by l.created_at desc limit 100`, [ctx.org.id]);
    const selectedId = leads.find((l) => l.id === wanted)?.id ?? leads[0]?.id ?? null;
    const lead = selectedId ? await maybeOne<any>(c, "select * from leads where id = $1", [selectedId]) : null;
    const messages = selectedId ? await q<any>(c, "select * from messages where lead_id = $1 order by created_at, id", [selectedId]) : [];
    const jobs = selectedId ? await q<any>(c, "select kind, run_at, payload from jobs where lead_id = $1 and status = 'queued' order by run_at limit 5", [selectedId]) : [];
    const notifications = await q<any>(c, `select n.*, l.full_name from notifications n left join leads l on l.id = n.lead_id
                                            where n.org_id = $1 order by n.created_at desc limit 30`, [ctx.org.id]);
    const members = await q<{ user_id: string; display_name: string }>(c, "select user_id, display_name from memberships where org_id = $1", [ctx.org.id]);
    return { sources, leads, lead, messages, jobs, notifications, members };
  });
  const { sources, leads, lead, messages, jobs, notifications, members } = data;
  const canEdit = lead ? !!(await withUserDb(ctx.user.id, (c) => maybeOne<{ ok: boolean }>(c, "select app.can_edit_lead($1) as ok", [lead.id])))?.ok : false;
  const leadTz = lead?.timezone ?? tz;
  const reviewed = leads.filter((l) => l.inbound > 0).length;
  const memberName = (id: string | null) => members.find((m) => m.user_id === id)?.display_name ?? "—";
  const simMessages: SimMessage[] = messages.map((m: any) => ({
    id: m.id, channel: m.channel, direction: m.direction, author: m.author, body: m.body, subject: m.subject, status: m.status,
    blocked_reason: m.blocked_reason, purpose: m.purpose, error: m.error, time: fmtTime(m.sent_at ?? m.created_at, leadTz, "ccc h:mma"),
  }));
  const disabled = !dry;

  return (
    <div className="space-y-6">
      {dry && <LiveRefresh orgId={ctx.org.id} tables={["messages", "leads", "notifications"]} supabaseUrl={env.devLogin ? null : env.supabaseUrl} anonKey={env.devLogin ? null : env.supabaseAnonKey} />}
      <PageHeader title="Simulator">
        Create fake leads, text as them and watch the agent work. Nothing is sent while dry-run is on.
      </PageHeader>

      {!dry && (
        <div className="card border-red-500/50 bg-red-500/10 p-4 text-sm" role="alert" data-testid="sim-disabled">
          <div className="font-semibold">The simulator is off because DRY_RUN is false.</div>
          Live mode sends real texts and emails, so fake leads and the simulation clock are disabled. Turn DRY_RUN back on to use the simulator.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Simulated time" value={<span className="text-lg">{DateTime.fromJSDate(at, { zone: tz }).toFormat("ccc LLL d, h:mm a")}</span>} sub={`${tz.replace("America/", "")} · offset ${fmtOffset(offsetMs)}`} />
        <Stat label="Conversations reviewed" value={`${reviewed} / ${REVIEW_TARGET}`} sub="Simulated leads that have replied (go-live needs 20)" />
        <Stat label="Simulated leads" value={leads.length} sub={`${leads.reduce((n, l) => n + l.pending, 0)} awaiting approval · ${leads.reduce((n, l) => n + l.blocked, 0)} blocked`} />
      </div>

      <fieldset disabled={disabled} className={cx("space-y-6", disabled && "pointer-events-none opacity-50")}>
        <Card className="flex flex-wrap items-center gap-2" data-testid="sim-clock">
          <form action={runNowAction}>
            <input type="hidden" name="lead_id" value={lead?.id ?? ""} />
            <SubmitButton variant="secondary" pendingLabel="Running…" title="Run every job that is due right now">Run now</SubmitButton>
          </form>
          <form action={runNowAction}>
            <input type="hidden" name="lead_id" value={lead?.id ?? ""} />
            <input type="hidden" name="skip_wait" value="1" />
            <SubmitButton variant="secondary" pendingLabel="Running…" title="Advance the clock 25 seconds (past the reply debounce) and run due jobs">Skip wait (+25s) &amp; run</SubmitButton>
          </form>
          <form action={advanceDayAction}>
            <input type="hidden" name="lead_id" value={lead?.id ?? ""} />
            <input type="hidden" name="days" value="1" />
            <SubmitButton pendingLabel="Fast-forwarding…" data-testid="advance-day">Advance 1 day</SubmitButton>
          </form>
          <form action={resetClockAction}>
            <SubmitButton variant="ghost" pendingLabel="…" disabled={!offsetMs}>Reset clock</SubmitButton>
          </form>
          <p className="w-full text-xs muted">
            The clock is shared by the whole platform (dry-run only). Advancing moves an hour at a time and runs every job that comes due, so follow-ups go out at their real simulated times and respect send windows.
          </p>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="space-y-6">
            <Card>
              <CardTitle>Create fake lead</CardTitle>
              {sources.length === 0 ? <p className="text-sm muted">Add a lead source first (Setup → lead sources).</p> : (
                <form action={createFakeLeadAction} className="space-y-3" data-testid="sim-create">
                  <Label>Name<Input name="name" required defaultValue="Taylor Test" /></Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Label hint="Fake 555-01xx">Phone<Input value="auto" disabled readOnly /></Label>
                    <Label>ZIP<Input name="zip" defaultValue="60126" inputMode="numeric" /></Label>
                  </div>
                  <Label hint="Optional — leave blank for SMS only">Email<Input name="email" type="email" placeholder="taylor@example.com" /></Label>
                  <Label>Model / interest<Input name="model" placeholder="X5" /></Label>
                  <Label hint="One per line, key: value">Other form answers<Textarea name="answers" rows={2} placeholder={"timeline: next month\ntrade_in: 2019 X3"} /></Label>
                  <Label>Lead source
                    <Select name="source_id" defaultValue={sources[0]?.id}>
                      {sources.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}{s.consent_verified_at && s.consent_covers_automated ? "" : " (no verified SMS consent: email only)"}</option>
                      ))}
                    </Select>
                  </Label>
                  <SubmitButton className="w-full" pendingLabel="Creating…">Create lead &amp; send first touch</SubmitButton>
                </form>
              )}
            </Card>

            <Card>
              <div className="mb-2 flex items-center justify-between">
                <CardTitle className="mb-0">Simulated leads</CardTitle>
                {ctx.isAdmin && leads.length > 0 && (
                  <form action={resetSimLeadsAction}>
                    <SubmitButton variant="ghost" className="px-2 py-1 text-xs text-red-600" pendingLabel="…">Reset all</SubmitButton>
                  </form>
                )}
              </div>
              {leads.length === 0 ? <p className="text-sm muted">None yet.</p> : (
                <ul className="-mx-2 max-h-[420px] space-y-1 overflow-y-auto">
                  {leads.map((l) => (
                    <li key={l.id}>
                      <Link href={`/simulator?lead=${l.id}`} className={cx("block rounded-lg px-2 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10", l.id === lead?.id && "bg-brand/10")}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{l.full_name ?? fmtPhone(l.phone_e164)}</span>
                          <Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-1 text-xs muted">
                          <span>AI {l.ai_status}</span>
                          {l.inbound > 0 && <span>· {l.inbound} repl{l.inbound === 1 ? "y" : "ies"}</span>}
                          {l.pending > 0 && <Badge tone="yellow">{l.pending} to approve</Badge>}
                          {l.blocked > 0 && <Badge tone="red">{l.blocked} blocked</Badge>}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="min-w-0 space-y-4">
            {!lead ? <Empty>Create a fake lead to start a conversation.</Empty> : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">{lead.full_name}</h2>
                    <div className="text-xs muted">{fmtPhone(lead.phone_e164)} · {lead.email ?? "no email"} · {leadTz.replace("America/", "")} · rep {memberName(lead.assigned_user_id)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STAGE_TONE[lead.stage]}>{stageLabel(lead.stage)}</Badge>
                    <Badge tone={lead.ai_status === "active" ? "green" : lead.ai_status === "paused" ? "yellow" : "red"}>AI {lead.ai_status}</Badge>
                    <Link href={`/leads/${lead.id}`} className="text-xs underline">Open lead</Link>
                  </div>
                </div>
                {lead.split_arm === "control" && <div className="card p-3 text-xs">This lead landed in the control arm of the 50/50 split, so the agent does not work it.</div>}
                {lead.ai_paused_reason && <div className="text-xs muted">AI {lead.ai_status}: {lead.ai_paused_reason}</div>}
                <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_1fr]">
                  <PhoneMockup
                    lead={{ id: lead.id, name: lead.full_name ?? "Lead", phone: fmtPhone(lead.phone_e164), business: ctx.org.name, optedOut: !!lead.opted_out_sms_at }}
                    messages={simMessages}
                    canApprove={canEdit}
                    disabled={disabled}
                  />
                  <div className="space-y-4">
                    <Card>
                      <CardTitle>Scheduled for this lead</CardTitle>
                      {jobs.length === 0 ? <p className="text-sm muted">Nothing queued.</p> : (
                        <ul className="space-y-1 text-sm">
                          {jobs.map((j: any, i: number) => {
                            const due = new Date(j.run_at).getTime() <= at.getTime();
                            return (
                              <li key={i} className="flex justify-between gap-2">
                                <span>{j.kind.replace(/_/g, " ")}{j.payload?.step != null ? ` #${j.payload.step + 1}` : ""}</span>
                                <span className={cx("text-xs", due ? "text-amber-600" : "muted")}>{due ? "due now" : fmtTime(j.run_at, leadTz, "ccc LLL d, h:mma")}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </Card>
                    <Card>
                      <CardTitle>Qualification</CardTitle>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        {Object.entries(lead.qualification ?? {}).length === 0 && <dd className="col-span-2 muted">Nothing captured yet.</dd>}
                        {Object.entries(lead.qualification ?? {}).map(([k, v]) => (
                          <div key={k} className="contents"><dt className="muted">{k.replace(/_/g, " ")}</dt><dd>{String(v)}</dd></div>
                        ))}
                      </dl>
                      {lead.summary && <p className="mt-2 whitespace-pre-line text-xs muted">{lead.summary}</p>}
                    </Card>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </fieldset>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Rep notifications</h2>
        <p className="mb-2 text-xs muted">Handoff and SLA alerts. In dry-run these are logged here instead of being texted or emailed.</p>
        {notifications.length === 0 ? <Empty>No notifications yet.</Empty> : (
          <ul className="space-y-2" data-testid="sim-notifications">
            {notifications.map((n: any) => (
              <li key={n.id} className="card p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{n.subject ?? n.kind.replace(/_/g, " ")}</span>
                  <span className="flex items-center gap-1 text-xs muted">
                    <Badge>{n.channel}</Badge>
                    <Badge tone={n.status === "sent" ? "green" : n.status === "failed" ? "red" : "gray"}>{n.status}{n.dry_run ? " (dry)" : ""}</Badge>
                    {fmtTime(n.created_at, tz)}
                  </span>
                </div>
                <div className="mt-1 text-xs muted">to {memberName(n.user_id)}{n.to_address ? ` (${n.to_address})` : ""}{n.full_name ? ` · re ${n.full_name}` : ""}</div>
                <div className="mt-1 line-clamp-3 whitespace-pre-line">{n.body}</div>
                {n.error && <div className="mt-1 text-xs text-red-600">{n.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
