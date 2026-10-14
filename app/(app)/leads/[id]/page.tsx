// Lead detail: the thread (AI messages badged), composer (sends as the rep and pauses the AI),
// AI controls, qualification panel, ad attribution, appointments, stage timeline with CAPI status.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, canEditLead } from "@/lib/auth";
import { maybeOne, q, withUserDb } from "@/lib/db";
import type { Lead, Message, Playbook } from "@/lib/db/types";
import { STAGES } from "@/lib/db/types";
import { env } from "@/lib/env";
import { fmtPhone, fmtTime } from "@/lib/format";
import { loadPlaybook } from "@/lib/agent/context";
import { openSlots } from "@/lib/booking/book";
import { formatSlot } from "@/lib/booking/slots";
import { service } from "@/lib/db";
import { Badge, Button, Card, CardTitle, Input, Select, STAGE_TONE, stageLabel, Textarea, cx } from "../../../_components/ui";
import { LiveRefresh } from "../../../_components/LiveRefresh";
import { aiControlAction, appointmentAction, approveAction, assignAction, bookManualAction, moveStageFormAction, rejectAction, sendMessageAction } from "../../../_actions/leads";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getOrgContext();
  const data = await withUserDb(ctx.user.id, async (c) => {
    const lead = await maybeOne<Lead>(c, "select * from leads where id = $1 and org_id = $2", [id, ctx.org.id]);
    if (!lead) return null;
    const [messages, appts, stages, capi, members, consent, runs] = await Promise.all([
      q<Message>(c, "select * from messages where lead_id = $1 order by created_at, id", [id]),
      q<any>(c, "select * from appointments where lead_id = $1 order by starts_at desc", [id]),
      q<any>(c, "select * from stage_events where lead_id = $1 order by created_at", [id]),
      q<any>(c, "select * from capi_events where lead_id = $1 order by created_at", [id]),
      q<{ user_id: string; display_name: string }>(c, "select user_id, display_name from memberships where org_id = $1 and active order by display_name", [ctx.org.id]),
      q<any>(c, "select * from consent_records where lead_id = $1 order by captured_at", [id]),
      q<any>(c, "select id, trigger, model, prompt_version, latency_ms, tokens_in, tokens_out, error, created_at from ai_runs where lead_id = $1 order by created_at desc limit 10", [id]),
    ]);
    return { lead, messages, appts, stages, capi, members, consent, runs };
  });
  if (!data) notFound();
  const { lead, messages, appts, stages, capi, members, consent, runs } = data;
  const tz = lead.timezone ?? ctx.org.timezone;
  const canEdit = await canEditLead(ctx.user.id, id);
  const playbook: Playbook = await loadPlaybook(service(), lead);
  const slots = canEdit ? await openSlots(service(), lead, playbook.booking).catch(() => []) : [];
  const repName = (uid: string | null) => members.find((m) => m.user_id === uid)?.display_name ?? null;
  const fields = Object.entries(playbook.qualification_fields ?? {});
  const smsConsent = consent.find((c: any) => c.channel === "sms");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <LiveRefresh orgId={ctx.org.id} tables={["messages", "leads", "appointments"]} supabaseUrl={env.devLogin ? null : env.supabaseUrl} anonKey={env.devLogin ? null : env.supabaseAnonKey} />
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link href="/leads" className="text-xs muted">← Leads</Link>
            <h1 className="text-xl font-semibold">{lead.full_name ?? fmtPhone(lead.phone_e164)}</h1>
            <div className="text-sm muted">{fmtPhone(lead.phone_e164)} · {lead.email ?? "no email"} · {tz.replace("America/", "")}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={STAGE_TONE[lead.stage]}>{stageLabel(lead.stage)}</Badge>
            <Badge tone={lead.ai_status === "active" ? "green" : lead.ai_status === "paused" ? "yellow" : "red"} data-testid="ai-status">AI {lead.ai_status}</Badge>
            {lead.opted_out_sms_at && <Badge tone="red">SMS opted out</Badge>}
            {lead.opted_out_email_at && <Badge tone="red">Email opted out</Badge>}
          </div>
        </div>

        <Card className="space-y-3 p-3">
          <ol className="space-y-2" data-testid="thread">
            {messages.length === 0 && <li className="text-sm muted">No messages yet.</li>}
            {messages.map((m) => <MessageRow key={m.id} m={m} tz={tz} rep={repName(m.author_user_id)} canEdit={canEdit} />)}
          </ol>
        </Card>

        {canEdit ? (
          <Card>
            <form action={sendMessageAction} className="space-y-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              <div className="flex gap-2">
                <Select name="channel" defaultValue={lead.phone_e164 && !lead.opted_out_sms_at ? "sms" : lead.email ? "email" : "note"} className="w-32">
                  <option value="sms" disabled={!lead.phone_e164 || !!lead.opted_out_sms_at}>Text</option>
                  <option value="email" disabled={!lead.email || !!lead.opted_out_email_at}>Email</option>
                  <option value="note">Internal note</option>
                </Select>
                <Input name="subject" placeholder="Subject (email only)" />
              </div>
              <Textarea name="body" placeholder={`Reply as ${ctx.membership?.display_name ?? "you"}…`} required data-testid="composer" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs muted">Sending pauses the AI on this thread.</span>
                <Button data-testid="send">Send</Button>
              </div>
            </form>
          </Card>
        ) : (
          <Card className="text-sm muted">This lead is assigned to {repName(lead.assigned_user_id)}. You can view it but not reply.</Card>
        )}
      </div>

      <aside className="space-y-4">
        <Card>
          <CardTitle>AI</CardTitle>
          <p className="mb-2 text-xs muted">{lead.ai_paused_reason ?? (lead.ai_status === "active" ? `Working this lead${lead.next_action_at ? ` · next touch ${fmtTime(lead.next_action_at, tz)}` : ""}` : "")}</p>
          {canEdit && (
            <form action={aiControlAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              {lead.ai_status === "paused" && <Button name="op" value="hand_back" data-testid="hand-back">Hand back to AI</Button>}
              {lead.ai_status === "active" && <Button name="op" value="pause" variant="secondary">Pause</Button>}
              {lead.ai_status === "stopped" && !lead.opted_out_sms_at && <Button name="op" value="resume" variant="secondary">Resume</Button>}
              {lead.ai_status !== "stopped" && <Button name="op" value="stop" variant="ghost">Stop</Button>}
            </form>
          )}
        </Card>

        <Card>
          <CardTitle>Qualification <span className="font-normal muted">· score {lead.score}{lead.warm ? " · warm" : ""}</span></CardTitle>
          <dl className="space-y-1 text-sm">
            {fields.map(([k, f]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="muted">{f.label}{f.required ? " *" : ""}</dt>
                <dd className={cx("text-right", !lead.qualification?.[k] && "muted")}>{String(lead.qualification?.[k] ?? "missing")}</dd>
              </div>
            ))}
          </dl>
          {lead.summary && <p className="mt-3 whitespace-pre-line border-t border-app pt-2 text-xs">{lead.summary}</p>}
        </Card>

        <Card>
          <CardTitle>Pipeline</CardTitle>
          {canEdit && (
            <form action={moveStageFormAction} className="mb-2 flex gap-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              <Select name="stage" defaultValue={lead.stage}>{STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}</Select>
              <Button variant="secondary">Move</Button>
            </form>
          )}
          {canEdit && (
            <form action={assignAction} className="mb-3 flex gap-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              <Select name="user_id" defaultValue={lead.assigned_user_id ?? ""}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
              </Select>
              <Button variant="secondary">Assign</Button>
            </form>
          )}
          <ol className="space-y-1 text-xs">
            {stages.map((s: any) => {
              const ev = capi.find((c: any) => c.stage_event_id === s.id);
              return (
                <li key={s.id} className="flex justify-between gap-2">
                  <span>{s.from_stage ? `${stageLabel(s.from_stage)} → ` : ""}<b>{stageLabel(s.to_stage)}</b> <span className="muted">by {s.actor}</span></span>
                  <span className="muted">{fmtTime(s.created_at, tz, "LLL d h:mma")}{ev && <> · <Badge tone={ev.status === "sent" ? "green" : ev.status === "failed" ? "red" : "gray"}>CAPI {ev.status}</Badge></>}</span>
                </li>
              );
            })}
          </ol>
        </Card>

        <Card>
          <CardTitle>Appointments</CardTitle>
          {appts.length === 0 && <p className="text-sm muted">None yet.</p>}
          <ul className="space-y-2">
            {appts.map((a: any) => (
              <li key={a.id} className="text-sm">
                <div className="flex justify-between"><span>{fmtTime(a.starts_at, tz, "ccc LLL d, h:mma")} · {a.kind.replace("_", " ")}</span><Badge>{a.status.replace("_", " ")}</Badge></div>
                {canEdit && (a.status === "booked" || a.status === "confirmed" || a.status === "showed") && (
                  <form action={appointmentAction} className="mt-1 flex flex-wrap gap-1">
                    <input type="hidden" name="appointment_id" value={a.id} />
                    {a.status !== "showed" && <Button name="op" value="showed" variant="secondary" className="px-2 py-1 text-xs">Showed</Button>}
                    {a.status !== "showed" && <Button name="op" value="no_show" variant="secondary" className="px-2 py-1 text-xs">No-show</Button>}
                    {a.status === "showed" && <Button name="op" value="sold" variant="secondary" className="px-2 py-1 text-xs">Sold</Button>}
                    {a.status !== "showed" && <Button name="op" value="canceled" variant="ghost" className="px-2 py-1 text-xs">Cancel</Button>}
                  </form>
                )}
              </li>
            ))}
          </ul>
          {canEdit && slots.length > 0 && (
            <form action={bookManualAction} className="mt-3 flex gap-2 border-t border-app pt-3">
              <input type="hidden" name="lead_id" value={lead.id} />
              <input type="hidden" name="minutes" value={playbook.booking?.slot_minutes ?? 45} />
              <input type="hidden" name="user_id" value={lead.assigned_user_id ?? ""} />
              <Select name="starts_at">{slots.map((s) => <option key={s.id} value={s.start.toISOString()}>{formatSlot(s, tz)}</option>)}</Select>
              <Button variant="secondary">Book</Button>
            </form>
          )}
        </Card>

        <Card>
          <CardTitle>Source</CardTitle>
          <dl className="space-y-1 text-xs">
            <Row k="Campaign" v={lead.campaign_name} /><Row k="Ad set" v={lead.adset_name} /><Row k="Ad" v={lead.ad_name} />
            <Row k="Meta lead id" v={lead.meta_lead_id} /><Row k="Created" v={fmtTime(lead.created_at, tz)} />
            <Row k="SMS consent" v={smsConsent ? (smsConsent.covers_automated ? "yes (automated)" : "yes (not automated)") : "none — email only"} />
            <Row k="Test arm" v={lead.split_arm} />
          </dl>
          {Object.keys(lead.answers ?? {}).length > 0 && (
            <details className="mt-2 text-xs"><summary className="cursor-pointer muted">Form answers</summary><pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(lead.answers, null, 2)}</pre></details>
          )}
          {runs.length > 0 && (
            <details className="mt-2 text-xs"><summary className="cursor-pointer muted">Recent AI runs</summary>
              <ul className="mt-1 space-y-1">{runs.map((r: any) => <li key={r.id}>{fmtTime(r.created_at, tz, "LLL d h:mma")} · {r.trigger} · {r.model} · {r.latency_ms}ms{r.error ? ` · ${r.error.slice(0, 60)}` : ""}</li>)}</ul>
            </details>
          )}
        </Card>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return <div className="flex justify-between gap-2"><dt className="muted">{k}</dt><dd className="truncate text-right">{v || "—"}</dd></div>;
}

function MessageRow({ m, tz, rep, canEdit }: { m: Message; tz: string; rep: string | null; canEdit: boolean }) {
  if (m.channel === "system" || m.channel === "note") {
    return (
      <li className="text-center text-xs muted">
        <span className={cx("inline-block rounded-md px-2 py-1", m.channel === "note" ? "bg-amber-500/10" : "bg-black/5 dark:bg-white/5")}>
          {m.channel === "note" ? `Note${rep ? ` · ${rep}` : ""}: ` : ""}{m.body} · {fmtTime(m.created_at, tz, "LLL d h:mma")}
        </span>
      </li>
    );
  }
  const inbound = m.direction === "inbound";
  return (
    <li className={cx("flex", inbound ? "justify-start" : "justify-end")} data-testid={`msg-${m.author}`}>
      <div className={cx("max-w-[85%] rounded-2xl px-3 py-2 text-sm", inbound ? "bg-black/5 dark:bg-white/10" : m.status === "blocked" ? "border border-dashed border-red-400 opacity-80" : "bg-brand text-brand-fg")}>
        {m.subject && <div className="mb-1 text-xs font-semibold opacity-80">{m.subject}</div>}
        <div className="whitespace-pre-wrap">{m.body}</div>
        <div className={cx("mt-1 flex flex-wrap items-center gap-1 text-[11px]", inbound ? "muted" : "opacity-80")}>
          <span>{m.channel.toUpperCase()}</span>·
          <span>{inbound ? "Lead" : m.author === "ai" ? "AI" : m.author === "user" ? rep ?? "Rep" : "System"}</span>·
          <span>{fmtTime(m.sent_at ?? m.created_at, tz, "LLL d h:mma")}</span>
          {!inbound && m.status !== "sent" && m.status !== "delivered" && <span className="rounded bg-black/20 px-1">{m.status.replace("_", " ")}{m.blocked_reason ? `: ${m.blocked_reason}` : ""}</span>}
          {m.dry_run && <span className="rounded bg-black/20 px-1">dry run</span>}
        </div>
        {m.status === "pending_approval" && canEdit && (
          <form className="mt-2 flex gap-1">
            <input type="hidden" name="message_id" value={m.id} />
            <Button formAction={approveAction} variant="secondary" className="px-2 py-1 text-xs">Approve</Button>
            <Button formAction={rejectAction} variant="ghost" className="px-2 py-1 text-xs text-inherit">Reject</Button>
          </form>
        )}
      </div>
    </li>
  );
}
