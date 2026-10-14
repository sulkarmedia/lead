import { describe, expect, it } from "vitest";
import { maybeOne, one, q, service } from "@/lib/db";
import { now } from "@/lib/clock";
import { seedDemo } from "@/lib/seed";
import { isWithinWindow, effectiveWindow } from "@/lib/compliance/sendWindow";
import { advanceAndRun, advanceClock, createSimulatedLead, drainDue, resetSimulatedLeads, SKIP_WAIT_MS, DAY_MS, textAsLead, isSimulatedLead } from "@/lib/simulator";
import { messagesFor, useTestEnv } from "../helpers";

useTestEnv(); // Wed 2026-10-14 12:00 CDT, frozen

async function setup() {
  const demo = await seedDemo(service(), { leads: 0, withAppointments: false });
  await q(service(), "update playbooks set approve_before_send = false where id = $1", [demo.playbookId]);
  return demo;
}

describe("simulator", () => {
  it("creates a marked fake lead, replies after skip-wait, and advancing a day sends the follow-up inside the window", async () => {
    const d = await setup();
    const r = await createSimulatedLead(service(), d.orgId, d.sourceId, { name: "Sim Tester", zip: "60126", answers: { which_model: "X5" } });
    expect(r.status).toBe("created");
    const leadId = (r as { leadId: string }).leadId;
    const lead = await one<any>(service(), "select * from leads where id = $1", [leadId]);
    expect(lead.phone_e164).toMatch(/^\+163055501\d\d$/);
    expect(lead.answers.simulated).toBe("true");
    expect(await isSimulatedLead(service(), d.orgId, leadId)).toBe(true);

    // First touch ran immediately.
    let ms = await messagesFor(leadId);
    expect(ms.some((m) => m.channel === "sms" && m.direction === "outbound" && m.purpose === "first_touch" && m.status === "sent")).toBe(true);

    // Text as the lead: nothing until the debounce passes.
    const aiCount = (await messagesFor(leadId)).filter((m) => m.author === "ai").length;
    const res = await textAsLead(service(), d.orgId, leadId, "Mostly configuration, I want the M Sport package");
    expect(res.action).toBe("agent_scheduled");
    await drainDue(service());
    expect((await messagesFor(leadId)).filter((m) => m.author === "ai").length).toBe(aiCount);
    await advanceClock(service(), SKIP_WAIT_MS);
    await drainDue(service());
    ms = await messagesFor(leadId);
    const inbound = ms.find((m) => m.direction === "inbound" && m.author === "lead");
    const reply = ms.find((m) => m.author === "ai" && m.direction === "outbound" && m.created_at > inbound.created_at && m.channel === "sms");
    expect(reply, JSON.stringify(ms.map((m) => [m.author, m.status, m.purpose, m.blocked_reason]))).toBeTruthy();
    expect(["sent", "pending_approval"]).toContain(reply.status);

    // Advance 1 day: the went-quiet follow-up (+1d after the lead's last message) goes out, inside the window.
    const before = now().getTime();
    await advanceAndRun(service(), DAY_MS);
    expect(now().getTime() - before).toBeGreaterThanOrEqual(DAY_MS);
    const followups = (await messagesFor(leadId)).filter((m) => m.purpose === "followup" && m.direction === "outbound" && m.status === "sent");
    expect(followups.length).toBeGreaterThanOrEqual(1);
    const w = effectiveWindow({ playbookWindow: { start: "09:00", end: "20:00", sundays: false }, orgSendSundays: false, orgSendHolidays: false, usState: "IL" });
    for (const m of followups.filter((x) => x.channel === "sms")) expect(isWithinWindow(m.sent_at, ["America/Chicago"], w), m.sent_at.toISOString()).toBe(true);
    expect(followups[0].sent_at.getTime()).toBeGreaterThan(before);
  });

  it("reset deletes only simulated leads and keeps consent records", async () => {
    const d = await seedDemo(service(), { leads: 2, withAppointments: false });
    const r = (await createSimulatedLead(service(), d.orgId, d.sourceId, { name: "Sim Two" })) as { leadId: string };
    const consents = (await q(service(), "select id from consent_records")).length;
    expect(await resetSimulatedLeads(service(), d.orgId)).toBe(1);
    expect(await maybeOne(service(), "select 1 from leads where id = $1", [r.leadId])).toBeNull();
    expect((await q(service(), "select id from leads where org_id = $1", [d.orgId])).length).toBe(2);
    expect((await q(service(), "select id from consent_records")).length).toBe(consents);
  });
});
