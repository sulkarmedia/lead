// Business-hour arithmetic for SLAs ("10 business-hour minutes").
import { DateTime } from "luxon";

type Weekly = Record<string, Array<[string, string]>>;
const KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function ranges(day: DateTime, weekly: Weekly): Array<[DateTime, DateTime]> {
  return (weekly[KEYS[day.weekday - 1]] ?? []).map(([a, b]) => {
    const [ah, am] = a.split(":").map(Number);
    const [bh, bm] = b.split(":").map(Number);
    return [day.set({ hour: ah, minute: am, second: 0, millisecond: 0 }), day.set({ hour: bh, minute: bm, second: 0, millisecond: 0 })];
  });
}

/** `start` + `minutes` of open business time. With no hours configured, plain minutes. */
export function addBusinessMinutes(start: Date, minutes: number, weekly: Weekly | null | undefined, tz: string): Date {
  if (!weekly || !Object.values(weekly).some((r) => r.length)) return new Date(start.getTime() + minutes * 60_000);
  let remaining = minutes * 60_000;
  let cursor = DateTime.fromJSDate(start, { zone: tz });
  for (let d = 0; d < 21; d++) {
    const day = cursor.startOf("day");
    for (const [open, close] of ranges(day, weekly)) {
      const from = cursor > open ? cursor : open;
      if (from >= close) continue;
      const avail = close.toMillis() - from.toMillis();
      if (avail >= remaining) return new Date(from.toMillis() + remaining);
      remaining -= avail;
    }
    cursor = day.plus({ days: 1 });
  }
  return new Date(start.getTime() + minutes * 60_000);
}
