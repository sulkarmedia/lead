// Send windows in the lead's local time. Default 09:00–20:00, configurable but clamped to 08:00–21:00.
// When the zone is a guess, a time is allowed only if it is inside the window in EVERY candidate zone.
import { DateTime } from "luxon";
import { isUsHoliday } from "./holidays";
import { PLATFORM_DEFAULTS, STATE_RULES } from "./state-rules";

export interface WindowConfig {
  start: string; // HH:MM
  end: string;   // HH:MM
  sundays: boolean;
  holidays: boolean;
}

export interface WindowInput {
  playbookWindow?: { start?: string; end?: string; sundays?: boolean } | null;
  orgSendSundays: boolean;
  orgSendHolidays: boolean;
  usState?: string | null;
}

const toMin = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Effective window: playbook/org settings, clamped to the hard limits, intersected with state rules. */
export function effectiveWindow(input: WindowInput): WindowConfig {
  const clampS = toMin(PLATFORM_DEFAULTS.clamp.start);
  const clampE = toMin(PLATFORM_DEFAULTS.clamp.end);
  let s = toMin(input.playbookWindow?.start ?? PLATFORM_DEFAULTS.window.start);
  let e = toMin(input.playbookWindow?.end ?? PLATFORM_DEFAULTS.window.end);
  s = Math.max(s, clampS);
  e = Math.min(e, clampE);
  let sundays = input.orgSendSundays && input.playbookWindow?.sundays !== false;
  let holidays = input.orgSendHolidays;
  const rule = input.usState ? STATE_RULES[input.usState] : undefined;
  if (rule?.window) {
    s = Math.max(s, toMin(rule.window.start));
    e = Math.min(e, toMin(rule.window.end));
  }
  if (rule?.sundays === false) sundays = false;
  if (rule?.holidays === false) holidays = false;
  if (e <= s) e = s; // empty window: nothing is ever allowed
  return { start: toHHMM(s), end: toHHMM(e), sundays, holidays };
}

/** Hard legal limits only (used for human-sent texts): 08:00–21:00, no day-of-week rules. */
export function hardLimitWindow(usState?: string | null): WindowConfig {
  const w = effectiveWindow({ playbookWindow: PLATFORM_DEFAULTS.clamp, orgSendSundays: true, orgSendHolidays: true, usState });
  return { ...w, sundays: true, holidays: true };
}

function allowedIn(at: Date, zone: string, w: WindowConfig): boolean {
  const local = DateTime.fromJSDate(at, { zone });
  if (!local.isValid) return false;
  if (!w.sundays && local.weekday === 7) return false;
  if (!w.holidays && isUsHoliday(local.toISODate()!)) return false;
  const m = local.hour * 60 + local.minute;
  return m >= toMin(w.start) && m < toMin(w.end);
}

/** Inside the window in every candidate zone. */
export function isWithinWindow(at: Date, zones: string[], w: WindowConfig): boolean {
  if (zones.length === 0) return false;
  return zones.every((z) => allowedIn(at, z, w));
}

/**
 * The first instant >= `from` that is inside the window in every candidate zone, or null if none
 * in the next 14 days. Allowed intervals in an intersection always begin at some zone's opening
 * time, so checking those instants is exact.
 */
export function nextWindowOpen(from: Date, zones: string[], w: WindowConfig): Date | null {
  if (isWithinWindow(from, zones, w)) return from;
  const startMin = toMin(w.start);
  const candidates: number[] = [];
  for (const zone of zones) {
    const base = DateTime.fromJSDate(from, { zone }).startOf("day");
    for (let d = 0; d <= 14; d++) {
      const open = base.plus({ days: d }).set({ hour: Math.floor(startMin / 60), minute: startMin % 60 });
      if (open.toMillis() >= from.getTime()) candidates.push(open.toMillis());
    }
  }
  candidates.sort((a, b) => a - b);
  for (const t of candidates) {
    if (isWithinWindow(new Date(t), zones, w)) return new Date(t);
  }
  return null;
}
