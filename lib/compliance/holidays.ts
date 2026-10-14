// US federal holidays, for orgs that turn off sending on holidays.
import { DateTime } from "luxon";

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  // weekday: 1=Mon..7=Sun (luxon); n=-1 means last
  if (n > 0) {
    let d = DateTime.fromObject({ year, month, day: 1 });
    while (d.weekday !== weekday) d = d.plus({ days: 1 });
    return d.plus({ weeks: n - 1 }).toISODate()!;
  }
  let d = DateTime.fromObject({ year, month, day: 1 }).endOf("month").startOf("day");
  while (d.weekday !== weekday) d = d.minus({ days: 1 });
  return d.toISODate()!;
}

export function usFederalHolidays(year: number): Set<string> {
  const fixed = (m: number, d: number) => DateTime.fromObject({ year, month: m, day: d }).toISODate()!;
  return new Set([
    fixed(1, 1), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1),
    fixed(6, 19), fixed(7, 4), nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2), fixed(11, 11),
    nthWeekday(year, 11, 4, 4), fixed(12, 25),
  ]);
}

export function isUsHoliday(isoDate: string): boolean {
  return usFederalHolidays(Number(isoDate.slice(0, 4))).has(isoDate);
}
