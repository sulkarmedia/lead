"use client";
// Phone mockup: the simulated lead's SMS thread as the lead sees it (their texts on the right),
// AI drafts waiting for approval, blocked sends with their reason, and email beneath.
import { useEffect, useRef } from "react";
import { Badge, Textarea, cx } from "../../../_components/ui";
import { approveAction, rejectAction } from "../../../_actions/leads";
import { textAsLeadAction } from "../../../_actions/simulator";
import { SubmitButton } from "./SubmitButton";

export interface SimMessage {
  id: string;
  channel: "sms" | "email" | "note" | "system";
  direction: "inbound" | "outbound" | "internal";
  author: "ai" | "user" | "lead" | "system";
  body: string;
  subject: string | null;
  status: string;
  blocked_reason: string | null;
  purpose: string | null;
  error: string | null;
  time: string; // pre-formatted in the lead's time zone (server-side, avoids hydration drift)
}

export function PhoneMockup({ lead, messages, canApprove, disabled }: {
  lead: { id: string; name: string; phone: string; business: string; optedOut: boolean };
  messages: SimMessage[];
  canApprove: boolean;
  disabled?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const sms = messages.filter((m) => m.channel === "sms" || m.channel === "system" || m.channel === "note");
  const email = messages.filter((m) => m.channel === "email");
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [sms.length]);

  return (
    <div className="space-y-4">
      <div className="mx-auto w-full max-w-[360px] rounded-[2.5rem] border-[10px] border-zinc-900 bg-zinc-900 shadow-xl dark:border-zinc-700">
        <div className="overflow-hidden rounded-[1.8rem] bg-[var(--card)]">
          <div className="border-b border-app bg-zinc-100 px-4 pb-2 pt-4 text-center dark:bg-zinc-800">
            <div className="mx-auto mb-2 h-1.5 w-16 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            <div className="text-sm font-semibold">{lead.business}</div>
            <div className="text-[11px] muted">texting {lead.name} · {lead.phone}</div>
          </div>
          <div ref={scroller} className="h-[440px] space-y-2 overflow-y-auto px-3 py-3" data-testid="sim-thread">
            {sms.length === 0 && <div className="pt-8 text-center text-xs muted">No texts yet.</div>}
            {sms.map((m) => <Bubble key={m.id} m={m} canApprove={canApprove && !disabled} />)}
          </div>
          <form action={textAsLeadAction} className="space-y-2 border-t border-app p-2">
            <input type="hidden" name="lead_id" value={lead.id} />
            <input type="hidden" name="channel" value="sms" />
            <div className="flex items-end gap-2">
              <Textarea name="body" rows={2} required placeholder={`Text as ${lead.name.split(" ")[0]}…`} className="min-h-0 flex-1 rounded-2xl" disabled={disabled} data-testid="sim-compose" />
              <SubmitButton className="rounded-full" disabled={disabled} pendingLabel="…">Send</SubmitButton>
            </div>
            <label className="flex items-center gap-2 px-1 text-xs muted">
              <input type="checkbox" name="skip_wait" defaultChecked disabled={disabled} />
              Skip the 20s wait and run the agent now
            </label>
            {lead.optedOut && <div className="px-1 text-xs text-red-600">This lead is opted out of SMS. Text START to opt back in.</div>}
          </form>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Email ({email.length})</h3>
        {email.length === 0 ? <div className="text-xs muted">No email messages.</div> : (
          <ul className="space-y-2">
            {email.map((m) => (
              <li key={m.id} className={cx("card p-3 text-sm", m.direction === "inbound" && "border-l-4 border-l-blue-500")}>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs muted">
                  <span>{m.direction === "inbound" ? "From lead" : m.author === "ai" ? "AI" : m.author} · {m.subject ?? "(no subject)"}</span>
                  <span className="flex items-center gap-1"><StatusBadge m={m} /> {m.time}</span>
                </div>
                <div className="whitespace-pre-wrap">{m.body}</div>
                {m.status === "blocked" && m.blocked_reason && <div className="mt-1 text-xs text-red-600">Blocked: {m.blocked_reason}</div>}
                {m.status === "pending_approval" && canApprove && !disabled && <ApproveForm m={m} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ m }: { m: SimMessage }) {
  if (m.status === "pending_approval") return <Badge tone="yellow">needs approval</Badge>;
  if (m.status === "blocked") return <Badge tone="red">blocked</Badge>;
  if (m.status === "failed") return <Badge tone="red">failed</Badge>;
  if (m.status === "queued") return <Badge tone="blue">queued</Badge>;
  return null;
}

function ApproveForm({ m }: { m: SimMessage }) {
  return (
    <form className="mt-2 space-y-1">
      <input type="hidden" name="message_id" value={m.id} />
      <Textarea name="body" defaultValue={m.body} rows={3} className="text-xs" />
      <div className="flex gap-2">
        <SubmitButton formAction={approveAction} className="px-2 py-1 text-xs" pendingLabel="Sending…">Approve &amp; send</SubmitButton>
        <SubmitButton formAction={rejectAction} variant="secondary" className="px-2 py-1 text-xs" pendingLabel="…">Reject</SubmitButton>
      </div>
    </form>
  );
}

function Bubble({ m, canApprove }: { m: SimMessage; canApprove: boolean }) {
  if (m.channel === "system" || m.channel === "note") {
    return <div className="px-4 text-center text-[11px] muted">{m.channel === "note" ? "Note: " : ""}{m.body} · {m.time}</div>;
  }
  const mine = m.direction === "inbound"; // the lead is holding this phone
  const pending = m.status === "pending_approval";
  const blocked = m.status === "blocked" || m.status === "failed";
  return (
    <div className={cx("flex flex-col", mine ? "items-end" : "items-start")} data-status={m.status}>
      <div
        className={cx(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
          mine ? "rounded-br-sm bg-blue-600 text-white" : "rounded-bl-sm bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100",
          pending && "border-2 border-dashed border-amber-500 bg-amber-50 text-zinc-900 dark:bg-amber-500/10 dark:text-zinc-100",
          blocked && "border-2 border-red-500 bg-red-50 text-zinc-900 line-through decoration-red-400/60 dark:bg-red-500/10 dark:text-zinc-100",
        )}
      >
        {m.body}
      </div>
      <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] muted">
        {!mine && <span>{m.author === "ai" ? "AI" : m.author === "user" ? "Rep" : m.author}{m.purpose ? ` · ${m.purpose.replace(/_/g, " ")}` : ""}</span>}
        <span>{m.time}</span>
        <StatusBadge m={m} />
      </div>
      {blocked && (m.blocked_reason || m.error) && <div className="max-w-[80%] px-1 text-[11px] text-red-600">{m.status === "blocked" ? "Not sent" : "Failed"}: {m.blocked_reason ?? m.error}</div>}
      {pending && canApprove && <div className="w-[80%]"><ApproveForm m={m} /></div>}
    </div>
  );
}
