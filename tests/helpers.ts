import { afterAll, beforeEach } from "vitest";
import { closePool, q, service } from "@/lib/db";
import { setNow, advance, now } from "@/lib/clock";
import { setModel } from "@/lib/agent/model";
import { offlineModel } from "@/lib/agent/offline";
import { createFakeSenders, setSenders } from "@/lib/messaging/sender";
import { tick } from "@/worker/index";

export const TABLES = [
  "notifications", "capi_events", "stage_events", "jobs", "appointments", "messages", "ai_runs", "consent_records", "leads",
  "knowledge_items", "lead_sources", "playbooks", "availability", "integrations", "memberships", "audit_log", "do_not_contact",
  "ad_spend_daily", "platform_admins", "platform_state", "organizations",
];

export async function resetDb() {
  await q(service(), "alter table consent_records disable trigger consent_records_immutable");
  await q(service(), `truncate ${TABLES.join(", ")}, auth.users cascade`);
  await q(service(), "alter table consent_records enable trigger consent_records_immutable");
}

/** Standard per-test setup: clean DB, frozen clock (Wed 2026-10-14 12:00 CDT), offline model, fake senders. */
export function useTestEnv(start = "2026-10-14T17:00:00Z") {
  let outbox = createFakeSenders();
  beforeEach(async () => {
    await resetDb();
    setNow(start);
    setModel(offlineModel);
    outbox = createFakeSenders();
    setSenders(outbox);
  });
  afterAll(async () => {
    setNow(null);
    setModel(null);
    setSenders(null);
    await closePool();
  });
  return { outbox: () => outbox.outbox };
}

/** Run the worker until nothing is due at the current (frozen) time. */
export async function drain(max = 200) {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const k = await tick("test-worker", 20);
    n += k;
    if (k === 0) break;
  }
  return n;
}

/** Advance the frozen clock in steps, draining due jobs at each step. */
export async function runFor(ms: number, stepMs = 15 * 60_000) {
  const end = now().getTime() + ms;
  while (now().getTime() < end) {
    const next = await q<{ run_at: Date }>(service(), "select run_at from jobs where status = 'queued' order by run_at limit 1");
    const target = Math.min(end, Math.max(now().getTime() + 1000, next[0] ? next[0].run_at.getTime() : end));
    advance(Math.min(target - now().getTime(), stepMs));
    await drain();
  }
}

export async function messagesFor(leadId: string) {
  return q<any>(service(), "select * from messages where lead_id = $1 order by created_at, id", [leadId]);
}
