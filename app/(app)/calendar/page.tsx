// Week view of appointments in the org time zone (?week=YYYY-MM-DD, any day of the week). Desktop
// shows seven columns; mobile shows a day list. Mark showed / no-show / sold / cancel; reschedule.
import Link from "next/link";
import { DateTime } from "luxon";
import { getOrgContext } from "@/lib/auth";
import { q, service, withUserDb } from "@/lib/db";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { openSlots } from "@/lib/booking/book";
import type { Slot } from "@/lib/booking/slots";
import { ButtonLink, Empty, PageHeader, cx } from "../../_components/ui";
import { LiveRefresh } from "../../_components/LiveRefresh";
import { ApptCard, type CalAppt } from "./_components/ApptCard";

export const dynamic = "force-dynamic";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string; mine?: string }> }) {
  const sp = await searchParams;
  const ctx = await getOrgContext();
  const tz = ctx.org.timezone;
  const today = DateTime.fromJSDate(now(), { zone: tz }).startOf("day");
  const picked = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? DateTime.fromISO(sp.week, { zone: tz }) : null;
  const weekStart = (picked?.isValid ? picked : today).startOf("week"); // Monday
  const weekEnd = weekStart.plus({ weeks: 1 });
  const mine = sp.mine === "1";

  const appts = await withUserDb(ctx.user.id, (c) =>
    q<CalAppt>(
      c,
      `select a.id, a.lead_id, a.user_id, a.starts_at, a.ends_at, a.kind, a.status,
              coalesce(l.full_name, l.phone_e164, l.email, 'Unknown') as lead_name, l.stage as lead_stage,
              m.display_name as rep_name, app.can_edit_lead(l.id) as can_edit
         from appointments a
         join leads l on l.id = a.lead_id
         left join memberships m on m.org_id = a.org_id and m.user_id = a.user_id
        where a.org_id = $1 and a.starts_at >= $2 and a.starts_at < $3 and l.deleted_at is null
          ${mine ? "and a.user_id = $4" : ""}
        order by a.starts_at, a.id`,
      mine ? [ctx.org.id, weekStart.toJSDate(), weekEnd.toJSDate(), ctx.user.id] : [ctx.org.id, weekStart.toJSDate(), weekEnd.toJSDate()],
    ),
  );

  // Open slots for rescheduling, per rep, only when something on screen can be moved.
  const at = now().getTime();
  const movable = appts.filter((a) => a.can_edit && (a.status === "booked" || a.status === "confirmed") && a.ends_at.getTime() > at - 24 * 3600_000);
  const slotsByUser = new Map<string, Slot[]>();
  for (const uid of new Set(movable.map((a) => a.user_id ?? ""))) {
    slotsByUser.set(uid, await openSlots(service(), { org_id: ctx.org.id, assigned_user_id: uid || null }, undefined, 14).catch(() => []));
  }
  const slotsFor = (a: CalAppt) => slotsByUser.get(a.user_id ?? "") ?? [];

  const days = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
  const byDay = days.map((d) => ({
    day: d,
    items: appts.filter((a) => DateTime.fromJSDate(a.starts_at, { zone: tz }).hasSame(d, "day")),
  }));
  const weekParam = (d: DateTime) => d.toISODate()!;
  const qs = (week: string) => `/calendar?week=${week}${mine ? "&mine=1" : ""}`;
  const active = appts.filter((a) => a.status !== "canceled").length;

  return (
    <div className="space-y-4">
      <LiveRefresh orgId={ctx.org.id} tables={["appointments"]} supabaseUrl={env.devLogin ? null : env.supabaseUrl} anonKey={env.devLogin ? null : env.supabaseAnonKey} />
      <PageHeader
        title="Calendar"
        actions={
          <>
            <ButtonLink variant="secondary" href={qs(weekParam(weekStart.minus({ weeks: 1 })))} aria-label="Previous week">←</ButtonLink>
            <ButtonLink variant="secondary" href={qs(weekParam(today))}>This week</ButtonLink>
            <ButtonLink variant="secondary" href={qs(weekParam(weekStart.plus({ weeks: 1 })))} aria-label="Next week">→</ButtonLink>
            <ButtonLink variant="ghost" href={`/calendar?week=${weekParam(weekStart)}${mine ? "" : "&mine=1"}`}>{mine ? "Everyone" : "Only mine"}</ButtonLink>
          </>
        }
      >
        {weekStart.toFormat("LLL d")} – {weekEnd.minus({ days: 1 }).toFormat("LLL d, yyyy")} · {active} appointment{active === 1 ? "" : "s"} · {tz.replace(/_/g, " ")}
      </PageHeader>

      {/* One list of days: stacked (only days with appointments) on mobile, a 7-column week on desktop. */}
      {appts.length === 0 && <div className="md:hidden"><Empty>No appointments this week.</Empty></div>}
      <div className="space-y-4 md:grid md:grid-cols-7 md:gap-2 md:space-y-0" data-testid="calendar-week">
        {byDay.map(({ day, items }) => {
          const isToday = day.hasSame(today, "day");
          return (
            <section key={day.toISODate()} className={cx("min-w-0", items.length === 0 && "hidden md:block")} data-testid={`calendar-day-${day.toISODate()}`}>
              <h2 className={cx("mb-2 text-sm font-semibold md:rounded-lg md:px-2 md:py-1 md:text-xs", isToday ? "text-brand md:bg-brand/10" : "md:text-[var(--muted)]")}>
                <span className="md:hidden">{day.toFormat("cccc, LLL d")}{isToday ? " · Today" : ""}</span>
                <span className="hidden md:inline">{day.toFormat("ccc")} <span className="tabular-nums">{day.toFormat("LLL d")}</span></span>
              </h2>
              <div className="space-y-2">
                {items.length === 0 ? <div className="px-2 text-xs muted">—</div> : items.map((a) => <ApptCard key={a.id} a={a} tz={tz} slots={slotsFor(a)} />)}
              </div>
            </section>
          );
        })}
      </div>
      <p className="text-xs muted">Times shown in {tz}. <Link className="underline" href="/leads">Book from a lead&apos;s page.</Link></p>
    </div>
  );
}
