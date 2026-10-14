import type { ReactNode } from "react";
import { Badge, Card, CardTitle } from "../../../../_components/ui";
import { CopyButton } from "./CopyButton";

export interface IntegrationRow {
  id: string;
  kind: string;
  user_id: string | null;
  status: string;
  config: Record<string, unknown>;
  has_secret: boolean;
  last_error: string | null;
  updated_at: Date;
}

const LABEL: Record<string, [string, "green" | "yellow" | "gray" | "red"]> = {
  connected: ["Connected", "green"],
  pending: ["Pending", "yellow"],
  not_connected: ["Not connected", "gray"],
  error: ["Error", "red"],
  blocked: ["Blocked", "red"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = LABEL[status] ?? [status, "gray"];
  return <Badge tone={tone} data-testid="integration-status">{label}</Badge>;
}

export function IntegrationCard({ title, status, row, children }: { title: string; status: string; row?: IntegrationRow | null; children: ReactNode }) {
  const effective = row?.status === "error" ? "error" : status;
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="mb-0">{title}</CardTitle>
        <StatusBadge status={effective} />
      </div>
      {row?.last_error && <p className="rounded-lg bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">Last error: {row.last_error}</p>}
      {children}
    </Card>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-black/5 px-2 py-1.5 text-xs dark:bg-white/10">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
