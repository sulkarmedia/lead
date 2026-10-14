// Pipeline: board by stage (drag a card to write a stage event) and a filterable table with search
// and CSV export. Both views use the same filters; ?view=table switches to the table.
import Link from "next/link";
import { getOrgContext } from "@/lib/auth";
import { withUserDb } from "@/lib/db";
import { STAGES } from "@/lib/db/types";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { ago, fmtPhone, fmtTime } from "@/lib/format";
import { Badge, Button, ButtonLink, Empty, Input, PageHeader, STAGE_TONE, Select, cx, stageLabel } from "../../_components/ui";
import { LiveRefresh } from "../../_components/LiveRefresh";
import { Board, type BoardCard } from "./_components/Board";
import { filterOptions, filterQuery, hasFilters, listLeads, parseFilters } from "./_components/filters";

export const dynamic = "force-dynamic";

const LIMIT = 500;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const view = sp.view === "table" ? "table" : "board";
  const ctx = await getOrgContext();
  const tz = ctx.org.timezone;
  const f = parseFilters(sp);
  const { leads, opts } = await withUserDb(ctx.user.id, async (c) => ({
    leads: await listLeads(c, ctx.org.id, tz, f, LIMIT),
    opts: await filterOptions(c, ctx.org.id),
  }));
  const at = now();
  const filtered = hasFilters(f);
  const name = (l: { full_name: string | null; phone_e164: string | null; email: string | null }) => l.full_name ?? (l.phone_e164 ? fmtPhone(l.phone_e164) : l.email ?? "Unknown");

  const cards: BoardCard[] = leads.map((l) => ({
    id: l.id,
    name: name(l),
    stage: l.stage as BoardCard["stage"],
    sub: [l.campaign_name, l.ad_name].filter(Boolean).join(" · ") || l.source_name || "—",
    rep: l.rep_name ?? "Unassigned",
    ai: l.ai_status,
    warm: l.warm,
    age: ago(l.created_at, at),
  }));

  return (
    <div className="space-y-4">
      <LiveRefresh orgId={ctx.org.id} tables={["leads"]} supabaseUrl={env.devLogin ? null : env.supabaseUrl} anonKey={env.devLogin ? null : env.supabaseAnonKey} />
      <PageHeader
        title="Leads"
        actions={
          <>
            <div className="inline-flex rounded-lg border border-app p-0.5 text-sm" role="tablist">
              <Link href={`/leads${filterQuery(f)}`} className={cx("rounded-md px-3 py-1.5", view === "board" && "bg-brand/10 font-medium text-brand")} aria-current={view === "board" ? "page" : undefined}>Board</Link>
              <Link href={`/leads${filterQuery(f, { view: "table" })}`} className={cx("rounded-md px-3 py-1.5", view === "table" && "bg-brand/10 font-medium text-brand")} aria-current={view === "table" ? "page" : undefined}>Table</Link>
            </div>
            <ButtonLink variant="secondary" href={`/leads/export${filterQuery(f)}`} prefetch={false} data-testid="csv-export">Export CSV</ButtonLink>
          </>
        }
      >
        {leads.length}{leads.length === LIMIT ? "+" : ""} lead{leads.length === 1 ? "" : "s"}{filtered ? " matching filters" : ""}
      </PageHeader>

      <form method="get" action="/leads" className="card grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="lead-filters">
        {view === "table" && <input type="hidden" name="view" value="table" />}
        <Input name="q" defaultValue={f.q ?? ""} placeholder="Search name, phone, email" className="col-span-2 sm:col-span-3 lg:col-span-2" type="search" aria-label="Search" />
        <Select name="stage" defaultValue={f.stage ?? ""} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
        </Select>
        <Select name="ai" defaultValue={f.ai ?? ""} aria-label="AI status">
          <option value="">Any AI status</option>
          <option value="active">AI active</option>
          <option value="paused">AI paused</option>
          <option value="stopped">AI stopped</option>
        </Select>
        <Select name="rep" defaultValue={f.rep ?? ""} aria-label="Rep">
          <option value="">All reps</option>
          <option value="none">Unassigned</option>
          {opts.reps.map((r) => <option key={r.user_id} value={r.user_id}>{r.display_name}</option>)}
        </Select>
        <Select name="source" defaultValue={f.source ?? ""} aria-label="Source">
          <option value="">All sources</option>
          {opts.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select name="campaign" defaultValue={f.campaign ?? ""} aria-label="Campaign">
          <option value="">All campaigns</option>
          {opts.campaigns.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        <Select name="ad" defaultValue={f.ad ?? ""} aria-label="Ad">
          <option value="">All ads</option>
          {opts.ads.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-xs muted">From <Input type="date" name="from" defaultValue={f.from ?? ""} aria-label="Created from" /></label>
        <label className="flex items-center gap-1 text-xs muted">To <Input type="date" name="to" defaultValue={f.to ?? ""} aria-label="Created to" /></label>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" className="flex-1">Filter</Button>
          {filtered && <ButtonLink variant="ghost" href={view === "table" ? "/leads?view=table" : "/leads"}>Clear</ButtonLink>}
        </div>
      </form>

      {view === "board" ? (
        <Board stages={STAGES} cards={cards} />
      ) : leads.length === 0 ? (
        <Empty>{filtered ? "No leads match these filters." : "No leads yet."}</Empty>
      ) : (
        <>
          {/* Mobile: stacked rows */}
          <ul className="space-y-2 md:hidden" data-testid="lead-table-mobile">
            {leads.map((l) => (
              <li key={l.id}>
                <Link href={`/leads/${l.id}`} className="card block p-3" data-testid="lead-row-mobile">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{name(l)}</span>
                    <Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs muted">{fmtPhone(l.phone_e164)} · {l.rep_name ?? "Unassigned"} · AI {l.ai_status} · {ago(l.created_at, at)}</div>
                  {l.campaign_name && <div className="truncate text-xs muted">{l.campaign_name}{l.ad_name ? ` · ${l.ad_name}` : ""}</div>}
                </Link>
              </li>
            ))}
          </ul>
          {/* Desktop: table */}
          <div className="card hidden overflow-x-auto p-0 md:block">
            <table className="w-full text-sm" data-testid="lead-table">
              <thead className="border-b border-app text-left text-xs muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">AI</th>
                  <th className="px-3 py-2 font-medium">Rep</th>
                  <th className="px-3 py-2 font-medium">Source / campaign / ad</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-b border-app last:border-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]" data-testid="lead-row">
                    <td className="px-3 py-2">
                      <Link href={`/leads/${l.id}`} className="font-medium underline-offset-2 hover:underline">{name(l)}</Link>
                      <div className="text-xs muted">{fmtPhone(l.phone_e164)}{l.email ? ` · ${l.email}` : ""}</div>
                    </td>
                    <td className="px-3 py-2"><Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge>{l.warm && <Badge tone="yellow" className="ml-1">Warm</Badge>}</td>
                    <td className="px-3 py-2"><Badge tone={l.ai_status === "active" ? "green" : l.ai_status === "paused" ? "yellow" : "red"}>{l.ai_status}</Badge>{l.split_arm === "control" && <Badge className="ml-1">control</Badge>}</td>
                    <td className="px-3 py-2">{l.rep_name ?? <span className="muted">Unassigned</span>}</td>
                    <td className="max-w-72 px-3 py-2 text-xs">
                      <div className="truncate">{l.source_name ?? "—"}</div>
                      <div className="truncate muted">{[l.campaign_name, l.ad_name].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs muted" title={fmtTime(l.created_at, tz)}>{ago(l.created_at, at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
