import { DateTime } from "luxon";
export const fmtTime = (d: Date | string | null | undefined, tz: string, fmt = "LLL d, h:mma") =>
  d ? DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat(fmt).replace("AM", "am").replace("PM", "pm") : "—";
export const ago = (d: Date | string | null | undefined, ref: Date = new Date()) => {
  if (!d) return "—";
  const s = Math.round((ref.getTime() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const fmtPhone = (e164: string | null | undefined) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 ?? "—";
};
