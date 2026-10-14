import { describe, expect, it } from "vitest";
import pg from "pg";
import { q, service } from "@/lib/db";
import { claimJobs, completeJob, enqueue } from "@/lib/jobs";
import { seedDemo } from "@/lib/seed";
import { useTestEnv } from "../helpers";

useTestEnv();

describe("worker queue", () => {
  it("with two workers running, each due job runs exactly once", async () => {
    const { orgId } = await seedDemo(service(), { leads: 0, withAppointments: false });
    for (let i = 0; i < 200; i++) await enqueue(service(), { orgId, kind: "daily_digest", runAt: new Date("2026-10-14T16:00:00Z"), payload: { i } });
    const url = process.env.DATABASE_URL!;
    const poolA = new pg.Pool({ connectionString: url, max: 3 });
    const poolB = new pg.Pool({ connectionString: url, max: 3 });
    const ran: string[] = [];
    const worker = async (pool: pg.Pool, id: string) => {
      for (;;) {
        const jobs = await claimJobs(pool, id, 7);
        if (jobs.length === 0) return;
        for (const j of jobs) {
          ran.push(j.id);
          await completeJob(pool, j.id);
        }
      }
    };
    await Promise.all([worker(poolA, "A"), worker(poolB, "B"), worker(poolA, "A2"), worker(poolB, "B2")]);
    await poolA.end();
    await poolB.end();
    expect(ran).toHaveLength(200);
    expect(new Set(ran).size).toBe(200);
    const rows = await q<{ attempts: number; status: string; locked_by: string }>(service(), "select attempts, status, locked_by from jobs");
    expect(rows.every((r) => r.attempts === 1 && r.status === "done")).toBe(true);
    expect(new Set(rows.map((r) => r.locked_by)).size).toBeGreaterThan(1);
  });

  it("does not run jobs before run_at and dedupes by key", async () => {
    const { orgId } = await seedDemo(service(), { leads: 0, withAppointments: false });
    await enqueue(service(), { orgId, kind: "daily_digest", runAt: new Date("2026-10-15T00:00:00Z"), dedupeKey: "k" });
    expect(await enqueue(service(), { orgId, kind: "daily_digest", dedupeKey: "k" })).toBeNull();
    expect(await claimJobs(service(), "x")).toHaveLength(0);
  });
});
