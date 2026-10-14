import { describe, expect, it } from "vitest";
import { one, q, service, withUserDb } from "@/lib/db";
import { now } from "@/lib/clock";
import { seedDemo } from "@/lib/seed";
import { armComparison, breakdown, costPerAppointment, summary, type Range } from "@/lib/metrics";
import { useTestEnv } from "../helpers";

useTestEnv();

const H = 3600_000;

interface LeadSpec {
  name: string;
  arm?: "agent" | "control";
  campaign: "c1" | "c2";
  ageH: number;
  speedSec?: number; // first outbound after creation
  inbound?: boolean;
  humanOutbound?: boolean;
  stage: string;
  stageEvents?: string[];
  appt?: "booked" | "showed";
  rep: string;
}

async function setup() {
  const d = await seedDemo(service(), { leads: 0, withAppointments: false });
  const org = d.orgId;
  const at = now().getTime();
  const ids: Record<string, string> = {};
  const specs: LeadSpec[] = [
    // A: went lost, but reached qualified on the way (stage event)
    { name: "A", campaign: "c1", ageH: 10, speedSec: 60, inbound: true, stage: "lost", stageEvents: ["qualified", "lost"], rep: d.repIds[0] },
    { name: "B", campaign: "c1", ageH: 20, speedSec: 120, inbound: true, stage: "appointment_set", appt: "booked", rep: d.repIds[0] },
    { name: "C", campaign: "c2", ageH: 30, speedSec: 300, humanOutbound: true, stage: "contacted", rep: d.repIds[1] },
    { name: "D", campaign: "c2", ageH: 40, stage: "new", rep: d.repIds[1] },
    { name: "E", campaign: "c1", ageH: 50, speedSec: 30, inbound: true, stage: "sold", stageEvents: ["qualified", "appointment_set", "showed", "sold"], appt: "showed", rep: d.repIds[0] },
    // control arm: not in AI metrics
    { name: "F", arm: "control", campaign: "c1", ageH: 5, stage: "new", rep: d.repIds[0] },
    { name: "G", arm: "control", campaign: "c2", ageH: 6, speedSec: 600, inbound: true, humanOutbound: true, stage: "appointment_set", appt: "booked", rep: d.repIds[1] },
    // outside the range
    { name: "H", campaign: "c1", ageH: 40 * 24, speedSec: 5, inbound: true, stage: "sold", appt: "showed", rep: d.repIds[0] },
  ];
  for (const s of specs) {
    const created = new Date(at - s.ageH * H);
    const first = s.speedSec !== undefined ? new Date(created.getTime() + s.speedSec * 1000) : null;
    const l = await one<{ id: string }>(
      service(),
      `insert into leads (org_id, source_id, meta_form_id, campaign_id, campaign_name, ad_name, full_name, stage, split_arm, assigned_user_id, created_at, first_outbound_at)
       values ($1, $2, 'demo_form_1', $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [org, d.sourceId, s.campaign, s.campaign === "c1" ? "Campaign One" : "Campaign Two", `ad-${s.campaign}`, s.name, s.stage, s.arm ?? "agent", s.rep, created, first],
    );
    ids[s.name] = l.id;
    if (first) {
      await q(service(), `insert into messages (org_id, lead_id, channel, direction, author, body, status, created_at) values ($1, $2, 'sms', 'outbound', $3, 'hi', 'sent', $4)`,
        [org, l.id, s.humanOutbound ? "user" : "ai", first]);
    }
    if (s.inbound) {
      await q(service(), `insert into messages (org_id, lead_id, channel, direction, author, body, status, created_at) values ($1, $2, 'sms', 'inbound', 'lead', 'yes', 'received', $3)`,
        [org, l.id, new Date(created.getTime() + 3600_000)]);
    }
    for (const st of s.stageEvents ?? []) {
      await q(service(), "insert into stage_events (org_id, lead_id, to_stage, actor, created_at) values ($1, $2, $3, 'test', $4)", [org, l.id, st, created]);
    }
    if (s.appt) {
      const start = new Date(at + 24 * H + Object.keys(ids).length * H);
      await q(service(), "insert into appointments (org_id, lead_id, user_id, starts_at, ends_at, status) values ($1, $2, $3, $4, $5, $6)",
        [org, l.id, s.rep, start, new Date(start.getTime() + 45 * 60_000), s.appt]);
    }
  }
  const range: Range = { from: new Date(at - 30 * 24 * H), to: new Date(at + 1) };
  return { ...d, ids, range };
}

describe("dashboard metrics", () => {
  it("computes the agent-arm funnel and median speed to lead, excluding control and out-of-range leads", async () => {
    const d = await setup();
    const s = await summary(service(), d.orgId, d.range);
    expect(s).toMatchObject({ leads: 5, contacted: 4, replied: 3, qualified: 3, appointments: 2, showed: 1, sold: 1 });
    expect(s.medianSpeedSec).toBe(90); // median of 30, 60, 120, 300
    expect(s.replyRate).toBeCloseTo(0.75);
    expect(s.qualifiedRate).toBeCloseTo(0.6);
    expect(s.appointmentRate).toBeCloseTo(0.4);
    expect(s.showRate).toBeCloseTo(0.5);
    // Same numbers through RLS as the signed-in owner.
    const viaRls = await withUserDb(d.ownerId, (c) => summary(c, d.orgId, d.range));
    expect(viaRls).toEqual(s);
  });

  it("splits by campaign, rep and AI- vs human-handled", async () => {
    const d = await setup();
    const byCampaign = await breakdown(service(), d.orgId, d.range, "campaign");
    expect(byCampaign.map((r) => [r.key, r.leads, r.appointments])).toEqual([["Campaign One", 3, 2], ["Campaign Two", 2, 0]]);
    const byRep = await breakdown(service(), d.orgId, d.range, "rep");
    expect(byRep.find((r) => r.key === "Sam Rivera")?.leads).toBe(3);
    const byHandler = await breakdown(service(), d.orgId, d.range, "handler");
    expect(Object.fromEntries(byHandler.map((r) => [r.key, r.leads]))).toEqual({ ai: 4, human: 1 });
    const byForm = await breakdown(service(), d.orgId, d.range, "form");
    expect(byForm).toHaveLength(1);
    expect(byForm[0].key).toBe("Pre-order form (Zapier)");
  });

  it("compares agent vs control arms", async () => {
    const d = await setup();
    const [agent, control] = await armComparison(service(), d.orgId, d.range);
    expect(agent.key).toBe("agent");
    expect(agent.leads).toBe(5);
    expect(control).toMatchObject({ key: "control", leads: 2, contacted: 1, replied: 1, appointments: 1, showed: 0, sold: 0 });
    expect(control.appointmentRate).toBeCloseTo(0.5);
  });

  it("cost per appointment by campaign uses spend inside the range and appointments from both arms", async () => {
    const d = await setup();
    expect(await costPerAppointment(service(), d.orgId, d.range)).toEqual([]);
    const ins = "insert into ad_spend_daily (org_id, day, campaign_id, campaign_name, spend) values ($1, $2, $3, $4, $5)";
    await q(service(), ins, [d.orgId, "2026-10-12", "c1", "Campaign One", 100]);
    await q(service(), ins, [d.orgId, "2026-10-13", "c1", "Campaign One", 50]);
    await q(service(), ins, [d.orgId, "2026-08-01", "c1", "Campaign One", 999]); // outside the range
    await q(service(), ins, [d.orgId, "2026-10-13", "c2", "Campaign Two", 80]);
    const cost = await costPerAppointment(service(), d.orgId, d.range);
    expect(cost).toEqual([
      { campaignId: "c1", campaignName: "Campaign One", spend: 150, appointments: 2, costPerAppointment: 75 },
      { campaignId: "c2", campaignName: "Campaign Two", spend: 80, appointments: 1, costPerAppointment: 80 },
    ]);
  });
});
