// One appointment on the calendar: lead, rep, kind, status, outcome buttons and a reschedule form.
import Link from "next/link";
import { fmtTime } from "@/lib/format";
import { formatSlot, type Slot } from "@/lib/booking/slots";
import { Badge, Button, Select, cx } from "../../../_components/ui";
import { appointmentAction } from "../../../_actions/leads";
import { rescheduleAction } from "../../../_actions/pipeline";

export interface CalAppt {
  id: string;
  lead_id: string;
  user_id: string | null;
  starts_at: Date;
  ends_at: Date;
  kind: "in_person" | "call" | "video";
  status: "booked" | "confirmed" | "showed" | "no_show" | "canceled";
  lead_name: string;
  lead_stage: string;
  rep_name: string | null;
  can_edit: boolean;
}

const STATUS_TONE = { booked: "blue", confirmed: "purple", showed: "green", no_show: "red", canceled: "gray" } as const;
const KIND = { in_person: "In person", call: "Call", video: "Video" } as const;

export function ApptCard({ a, tz, slots, compact }: { a: CalAppt; tz: string; slots: Slot[]; compact?: boolean }) {
  const live = a.status === "booked" || a.status === "confirmed";
  const btn = "px-2 py-1 text-xs";
  return (
    <div className={cx("card p-2.5 text-sm", a.status === "canceled" && "opacity-60")} data-testid="appointment">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium tabular-nums">{fmtTime(a.starts_at, tz, "h:mma")}–{fmtTime(a.ends_at, tz, "h:mma")}</div>
          <Link href={`/leads/${a.lead_id}`} className={cx("block truncate font-medium underline-offset-2 hover:underline", a.status === "canceled" && "line-through")}>{a.lead_name}</Link>
        </div>
        <Badge tone={STATUS_TONE[a.status]}>{a.status.replace("_", " ")}</Badge>
      </div>
      <div className="mt-0.5 truncate text-xs muted">{a.rep_name ?? "Unassigned"} · {KIND[a.kind]}</div>
      {a.can_edit && (live || a.status === "showed") && (
        <form action={appointmentAction} className={cx("mt-2 flex flex-wrap gap-1", compact && "gap-0.5")}>
          <input type="hidden" name="appointment_id" value={a.id} />
          {live && <Button name="op" value="showed" variant="secondary" className={btn}>Showed</Button>}
          {live && <Button name="op" value="no_show" variant="secondary" className={btn}>No-show</Button>}
          {a.lead_stage !== "sold" && <Button name="op" value="sold" variant="secondary" className={btn}>Sold</Button>}
          {live && <Button name="op" value="canceled" variant="ghost" className={btn}>Cancel</Button>}
        </form>
      )}
      {a.can_edit && live && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs muted">Reschedule</summary>
          {slots.length === 0 ? (
            <div className="mt-1 text-xs muted">No open times in the booking window.</div>
          ) : (
            <form action={rescheduleAction} className="mt-1 space-y-1">
              <input type="hidden" name="appointment_id" value={a.id} />
              <Select name="slot" aria-label="New time" className="px-2 py-1 text-xs">
                {slots.map((s) => (
                  <option key={s.id} value={`${s.start.toISOString()}|${s.end.toISOString()}|${s.userId ?? ""}`}>{formatSlot(s, tz)}</option>
                ))}
              </Select>
              <Button variant="secondary" className={cx(btn, "w-full")}>Move</Button>
            </form>
          )}
        </details>
      )}
    </div>
  );
}
