// Funnel table for one breakdown. Rates carry a thin single-hue bar (magnitude only) beside the
// number; the number is always printed, so the bar is never the only encoding.
import type { FunnelRow } from "@/lib/metrics";
import { Card, CardTitle } from "../../../_components/ui";

export const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);

export function fmtDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.round((sec / 86400) * 10) / 10}d`;
}

export function RateCell({ value, label }: { value: number | null; label: string }) {
  const w = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <td className="px-3 py-2" title={`${label}: ${pct(value)}`}>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-right tabular-nums">{pct(value)}</span>
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-black/5 sm:block dark:bg-white/10" aria-hidden>
          <span className="block h-full rounded-full bg-brand" style={{ width: `${w}%` }} />
        </span>
      </div>
    </td>
  );
}

export function MetricsTable({ title, rows, keyLabel, labelFor, testId }: { title: string; rows: FunnelRow[]; keyLabel: string; labelFor?: (k: string) => string; testId?: string }) {
  return (
    <Card className="p-0" data-testid={testId}>
      <CardTitle className="px-4 pt-4">{title}</CardTitle>
      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-sm muted">No leads in this range.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-app text-left text-xs muted">
              <tr>
                <th className="px-3 py-2 font-medium">{keyLabel}</th>
                <th className="px-3 py-2 text-right font-medium">Leads</th>
                <th className="px-3 py-2 font-medium">Speed</th>
                <th className="px-3 py-2 font-medium">Reply</th>
                <th className="px-3 py-2 font-medium">Qualified</th>
                <th className="px-3 py-2 font-medium">Appt</th>
                <th className="px-3 py-2 font-medium">Show</th>
                <th className="px-3 py-2 text-right font-medium">Sold</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-app last:border-0">
                  <td className="max-w-56 truncate px-3 py-2 font-medium" title={labelFor ? labelFor(r.key) : r.key}>{labelFor ? labelFor(r.key) : r.key}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.leads}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtDuration(r.medianSpeedSec)}</td>
                  <RateCell value={r.replyRate} label="Reply rate" />
                  <RateCell value={r.qualifiedRate} label="Qualified rate" />
                  <RateCell value={r.appointmentRate} label="Appointment rate" />
                  <RateCell value={r.showRate} label="Show rate" />
                  <td className="px-3 py-2 text-right tabular-nums">{r.sold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
