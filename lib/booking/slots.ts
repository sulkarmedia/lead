// Open slots = availability (business hours) minus existing appointments minus calendar busy times,
// respecting slot length, buffer, minimum notice, horizon and blackout dates.
import { DateTime } from "luxon";
import type { Availability } from "../db/types";

export interface Interval { start: Date; end: Date }
export interface Slot { id: string; start: Date; end: Date; userId: string | null }

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]; // luxon weekday 1..7

export function slotId(start: Date, userId: string | null): string {
  const t = DateTime.fromJSDate(start, { zone: "utc" }).toFormat("yyyyLLdd'T'HHmm'Z'");
  return userId ? `slot_${t}_${userId.slice(0, 8)}` : `slot_${t}`;
}

export function computeSlots(input: {
  availability: Pick<Availability, "weekly_hours" | "slot_minutes" | "buffer_minutes" | "min_notice_minutes" | "max_days_ahead" | "blackout_dates">;
  businessTz: string;
  userId: string | null;
  booked: Interval[];
  busy: Interval[];
  now: Date;
  overrides?: { slot_minutes?: number; min_notice_minutes?: number; days_ahead?: number };
}): Slot[] {
  const a = input.availability;
  const len = input.overrides?.slot_minutes ?? a.slot_minutes;
  const buffer = a.buffer_minutes;
  const notice = input.overrides?.min_notice_minutes ?? a.min_notice_minutes;
  const days = Math.min(input.overrides?.days_ahead ?? a.max_days_ahead, a.max_days_ahead);
  const earliest = input.now.getTime() + notice * 60_000;
  const horizon = input.now.getTime() + days * 86400_000;
  const blackout = new Set(a.blackout_dates ?? []);
  const taken = [...input.booked, ...input.busy];
  const out: Slot[] = [];
  const startDay = DateTime.fromJSDate(input.now, { zone: input.businessTz }).startOf("day");
  for (let d = 0; d <= days; d++) {
    const day = startDay.plus({ days: d });
    if (blackout.has(day.toISODate()!)) continue;
    const ranges = a.weekly_hours[DAY_KEYS[day.weekday - 1]] ?? [];
    for (const [from, to] of ranges) {
      const [fh, fm] = from.split(":").map(Number);
      const [th, tm] = to.split(":").map(Number);
      let s = day.set({ hour: fh, minute: fm });
      const close = day.set({ hour: th, minute: tm });
      while (s.plus({ minutes: len }) <= close) {
        const start = s.toJSDate();
        const end = s.plus({ minutes: len }).toJSDate();
        const t = start.getTime();
        if (t >= earliest && t <= horizon) {
          const padS = t - buffer * 60_000;
          const padE = end.getTime() + buffer * 60_000;
          const clash = taken.some((b) => b.start.getTime() < padE && b.end.getTime() > padS);
          if (!clash) out.push({ id: slotId(start, input.userId), start, end, userId: input.userId });
        }
        s = s.plus({ minutes: len + buffer });
      }
    }
  }
  return out;
}

/** Up to `max` slots spread across days: at most two per day (earliest and one after noon). */
export function pickSpread(slots: Slot[], businessTz: string, max = 6): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const k = DateTime.fromJSDate(s.start, { zone: businessTz }).toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const out: Slot[] = [];
  for (const list of byDay.values()) {
    const first = list[0];
    const afternoon = list.find((s) => DateTime.fromJSDate(s.start, { zone: businessTz }).hour >= 13 && s !== first);
    out.push(first);
    if (afternoon) out.push(afternoon);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

export function formatSlot(s: { start: Date }, tz: string): string {
  return DateTime.fromJSDate(s.start, { zone: tz }).toFormat("cccc LLL d 'at' h:mma").replace("AM", "am").replace("PM", "pm");
}
