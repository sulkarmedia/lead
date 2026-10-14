// CSV export of the lead list with the same filters as /leads. Read through RLS as the signed-in user.
import { getOrgContext } from "@/lib/auth";
import { withUserDb } from "@/lib/db";
import { now } from "@/lib/clock";
import { DateTime } from "luxon";
import { listLeads, parseFilters } from "../_components/filters";

export const dynamic = "force-dynamic";

const iso = (d: Date | null, tz: string) => (d ? DateTime.fromJSDate(new Date(d), { zone: tz }).toISO({ suppressMilliseconds: true }) ?? "" : "");

/** Quote for CSV, and neutralise spreadsheet formulas (=, @, +/- not followed by a number). */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().]*$)/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const ctx = await getOrgContext();
  const tz = ctx.org.timezone;
  const f = parseFilters(new URL(req.url).searchParams);
  const rows = await withUserDb(ctx.user.id, (c) => listLeads(c, ctx.org.id, tz, f, 50_000));
  const header = ["id", "created_at", "name", "phone", "email", "stage", "ai_status", "split_arm", "score", "warm", "source", "campaign", "adset", "ad", "rep", "first_outbound_at", "last_inbound_at"];
  const lines = [header.join(",")];
  for (const l of rows) {
    lines.push([
      l.id, iso(l.created_at, tz), l.full_name, l.phone_e164, l.email, l.stage, l.ai_status, l.split_arm, l.score, l.warm, l.source_name,
      l.campaign_name, l.adset_name, l.ad_name, l.rep_name, iso(l.first_outbound_at, tz), iso(l.last_inbound_at, tz),
    ].map(csvCell).join(","));
  }
  const stamp = DateTime.fromJSDate(now(), { zone: tz }).toFormat("yyyyLLdd-HHmm");
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${ctx.org.slug}-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
