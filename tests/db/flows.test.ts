import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { maybeOne, one, q, service } from "@/lib/db";
import { advance, now, setNow } from "@/lib/clock";
import { seedDemo } from "@/lib/seed";
import { ingestLead } from "@/lib/leads/intake";
import { handleInbound } from "@/lib/conversation";
import { handBackToAi, sendAsRep } from "@/lib/inbox";
import { isWithinWindow, effectiveWindow } from "@/lib/compliance/sendWindow";
import { runFirstTouchNow } from "@/worker/fastpath";
import { drain, messagesFor, runFor, useTestEnv } from "../helpers";

const env = useTestEnv();

async function setup(opts: { approve?: boolean } = {}) {
  const demo = await seedDemo(service(), { leads: 0, withAppointments: false });
  await q(service(), "update playbooks set approve_before_send = $2 where id = $1", [demo.playbookId, opts.approve ?? false]);
  return demo;
}

const lead = (o: Record<string, unknown> = {}) => ({
  meta_lead_id: `ml_${Math.random().toString(36).slice(2)}`, form_id: "demo_form_1", full_name: "maria GARCIA", phone: "(630) 555-0199",
  email: "Maria@Example.com", zip: "60126", campaign_name: "Pre-order | X5", ad_name: "X5 carousel", which_model: "X5", ...o,
});

describe("intake", () => {
  it("normalizes, snapshots consent, assigns a rep and dedupes", async () => {
    const d = await setup();
    const r = await ingestLead(d.orgId, d.sourceId, lead({ meta_lead_id: "123" }));
    expect(r.status).toBe("created");
    const l = await one<any>(service(), "select * from leads where meta_lead_id = '123'");
    expect(l).toMatchObject({ phone_e164: "+16305550199", email: "maria@example.com", first_name: "Maria", last_name: "Garcia", us_state: "IL", timezone: "America/Chicago", stage: "new" });
    expect(d.repIds).toContain(l.assigned_user_id);
    expect(await one<any>(service(), "select * from consent_records where lead_id = $1 and channel = 'sms'", [l.id])).toMatchObject({ covers_automated: true });
    expect((await ingestLead(d.orgId, d.sourceId, lead({ meta_lead_id: "123" }))).status).toBe("duplicate");
    expect((await ingestLead(d.orgId, d.sourceId, lead({ meta_lead_id: "456" }))).status).toBe("resubmitted");
    expect((await q(service(), "select id from leads")).length).toBe(1);
  });

  it("a source without verified consent makes the lead email-only", async () => {
    const d = await setup();
    await q(service(), "update lead_sources set consent_verified_at = null where id = $1", [d.sourceId]);
    const r = await ingestLead(d.orgId, d.sourceId, lead());
    expect(await maybeOne(service(), "select 1 from consent_records where lead_id = $1 and channel = 'sms'", [(r as any).leadId])).toBeNull();
    await drain();
    const ms = await messagesFor((r as any).leadId);
    expect(ms.filter((m) => m.direction === "outbound" && m.status === "sent").map((m) => m.channel)).toEqual(["email"]);
  });

  it("reactivates a lost lead on re-submission within 30 days", async () => {
    const d = await setup();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await q(service(), "update leads set stage = 'lost', ai_status = 'stopped' where id = $1", [r.leadId]);
    advance(5 * 86400_000);
    expect((await ingestLead(d.orgId, d.sourceId, lead())).status).toBe("resubmitted");
    expect(await one<any>(service(), "select stage, ai_status from leads where id = $1", [r.leadId])).toMatchObject({ stage: "engaged", ai_status: "active" });
  });
});

describe("phase 1 acceptance", () => {
  it("a Zapier test lead gets its first SMS in under 60 seconds", async () => {
    const d = await setup();
    const t0 = Date.now();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await runFirstTouchNow(r.leadId);
    const sms = (await messagesFor(r.leadId)).find((m) => m.channel === "sms" && m.direction === "outbound");
    expect(sms.status).toBe("sent");
    expect(sms.sent_at.getTime() - now().getTime()).toBeLessThan(60_000);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(sms.body).toMatch(/BMW of Elmhurst/);
    expect(sms.body).toMatch(/virtual assistant/);
    expect(sms.consent_record_id).toBeTruthy();
    expect(env.outbox().some((o) => o.channel === "sms")).toBe(true);
    expect(await one<any>(service(), "select stage from leads where id = $1", [r.leadId])).toMatchObject({ stage: "contacted" });
  });

  it("a lead outside the window gets email now and SMS when the window opens", async () => {
    setNow("2026-10-15T03:30:00Z"); // Wed 22:30 CDT
    const d = await setup();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await drain();
    let ms = await messagesFor(r.leadId);
    expect(ms.find((m) => m.channel === "email" && m.direction === "outbound").status).toBe("sent");
    const sms = ms.find((m) => m.channel === "sms" && m.direction === "outbound");
    expect(sms.status).toBe("queued");
    const job = await one<any>(service(), "select run_at from jobs where kind = 'scheduled_send' and status = 'queued'");
    expect(job.run_at.toISOString()).toBe("2026-10-15T14:00:00.000Z"); // Thu 09:00 CDT
    setNow("2026-10-15T14:00:00Z");
    await drain();
    ms = await messagesFor(r.leadId);
    const sent = ms.find((m) => m.id === sms.id);
    expect(sent.status).toBe("sent");
    expect(sent.sent_at.toISOString()).toBe("2026-10-15T14:00:00.000Z");
  });

  it.each([["STOP", true], ["don't text me", false]])('"%s" ends all future SMS with one confirmation', async (text, carrier) => {
    const d = await setup();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await drain();
    const l = await one<any>(service(), "select * from leads where id = $1", [r.leadId]);
    await handleInbound(service(), { orgId: d.orgId, leadId: l.id, channel: "sms", body: text, carrierHandledOptOut: carrier ? "STOP" : null });
    await handleInbound(service(), { orgId: d.orgId, leadId: l.id, channel: "sms", body: text });
    await runFor(60 * 86400_000, 6 * 3600_000);
    const out = (await messagesFor(l.id)).filter((m) => m.channel === "sms" && m.direction === "outbound" && m.status === "sent");
    const after = out.filter((m) => m.purpose !== "first_touch");
    // Carrier keyword: Twilio Advanced Opt-Out already confirmed, so we send none. Plain language: exactly one from us.
    expect(after.map((m) => m.purpose)).toEqual(carrier ? [] : ["opt_out_confirmation"]);
    expect((await one<any>(service(), "select opted_out_sms_at from leads where id = $1", [l.id])).opted_out_sms_at).toBeTruthy();
  });

  it("a rep reply pauses the AI; hand-back resumes the cadence", async () => {
    const d = await setup();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await drain();
    await handleInbound(service(), { orgId: d.orgId, leadId: r.leadId, channel: "sms", body: "Mostly configuration questions" });
    await sendAsRep(service(), { leadId: r.leadId, userId: d.repIds[0], channel: "sms", body: "Hi Maria, Sam here. Happy to help." });
    let l = await one<any>(service(), "select * from leads where id = $1", [r.leadId]);
    expect(l.ai_status).toBe("paused");
    expect(await q(service(), "select 1 from jobs where lead_id = $1 and status = 'queued' and kind in ('followup', 'agent_reply')", [r.leadId])).toHaveLength(0);
    advance(60_000);
    await drain();
    const aiAfterRep = (await messagesFor(r.leadId)).filter((m) => m.author === "ai" && m.created_at > l.updated_at);
    expect(aiAfterRep).toHaveLength(0);
    await handBackToAi(service(), r.leadId, d.repIds[0]);
    l = await one<any>(service(), "select * from leads where id = $1", [r.leadId]);
    expect(l.ai_status).toBe("active");
    expect(await one<any>(service(), "select kind from jobs where lead_id = $1 and status = 'queued' and kind = 'followup'", [r.leadId])).toBeTruthy();
  });

  it("30 simulated days produce exactly the scheduled touches, none outside the window", async () => {
    setNow("2026-10-14T19:00:00Z"); // Wed 14:00 CDT
    const d = await setup();
    const r = (await ingestLead(d.orgId, d.sourceId, lead())) as any;
    await runFor(30 * 86400_000, 3600_000);
    const all = await messagesFor(r.leadId);
    if (process.env.DEBUG_FLOW) console.log(all.map((m) => [m.created_at.toISOString(), m.channel, m.status, m.purpose, m.blocked_reason, m.body.slice(0, 50)]), await q(service(), "select kind, status, run_at, last_error, payload from jobs where lead_id = $1 order by created_at", [r.leadId]));
    const out = all.filter((m) => m.direction === "outbound" && m.status === "sent");
    const sms = out.filter((m) => m.channel === "sms");
    const email = out.filter((m) => m.channel === "email");
    // first touch (sms+email), +2h sms, +1d both, +3d sms, +7d email, +14d sms, +30d both
    expect(sms.map((m) => m.purpose)).toEqual(["first_touch", "followup", "followup", "followup", "followup", "followup"]);
    expect(email.map((m) => m.purpose)).toEqual(["first_touch", "followup", "followup", "followup"]);
    const w = effectiveWindow({ playbookWindow: { start: "09:00", end: "20:00", sundays: false }, orgSendSundays: false, orgSendHolidays: false, usState: "IL" });
    for (const m of sms) expect(isWithinWindow(m.sent_at, ["America/Chicago"], w), m.sent_at.toISOString()).toBe(true);
    // never more than 3 automated per channel per 24h
    for (const m of sms) expect(sms.filter((x) => Math.abs(x.sent_at - m.sent_at) < 86400_000 && x.sent_at <= m.sent_at).length).toBeLessThanOrEqual(3);
    const l = await one<any>(service(), "select stage, cadence_step from leads where id = $1", [r.leadId]);
    expect(l.cadence_step).toBe(6);
  });
});
