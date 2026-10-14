import { describe, expect, it } from "vitest";
import { one, q, service } from "@/lib/db";
import { advance, now, setNow } from "@/lib/clock";
import { seedDemo } from "@/lib/seed";
import { ingestLead } from "@/lib/leads/intake";
import { bookSlot, openSlots } from "@/lib/booking/book";
import { handleInbound } from "@/lib/conversation";
import { handoff } from "@/lib/handoff";
import { sendAsRep } from "@/lib/inbox";
import { markAppointment } from "@/lib/appointments";
import { setStage } from "@/lib/leads/stages";
import { isWithinWindow, effectiveWindow } from "@/lib/compliance/sendWindow";
import { drain, messagesFor, runFor, useTestEnv } from "../helpers";

const env = useTestEnv();

async function setup() {
  const d = await seedDemo(service(), { leads: 0, withAppointments: false });
  await q(service(), "update playbooks set approve_before_send = false where id = $1", [d.playbookId]);
  const r = (await ingestLead(d.orgId, d.sourceId, { meta_lead_id: "991", full_name: "Maria Garcia", phone: "6305550199", email: "m@example.com", zip: "60126" })) as any;
  await drain();
  const lead = await one<any>(service(), "select * from leads where id = $1", [r.leadId]);
  return { ...d, lead };
}

describe("booking", () => {
  it("two simultaneous bookings of one slot: exactly one succeeds", async () => {
    const d = await setup();
    const r2 = (await ingestLead(d.orgId, d.sourceId, { full_name: "Other Person", phone: "6305550123", zip: "60126" })) as any;
    await q(service(), "update leads set assigned_user_id = $2 where id = $1", [r2.leadId, d.lead.assigned_user_id]);
    const [slot] = await openSlots(service(), d.lead);
    const results = await Promise.all([
      bookSlot({ orgId: d.orgId, leadId: d.lead.id, slot, createdBy: "test" }),
      bookSlot({ orgId: d.orgId, leadId: r2.leadId, slot, createdBy: "test" }),
      bookSlot({ orgId: d.orgId, leadId: d.lead.id, slot, createdBy: "test" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await q(service(), "select 1 from appointments where starts_at = $1", [slot.start])).toHaveLength(1);
  });

  it("the agent offers two times, the lead picks one, code books it and confirms with the address", async () => {
    const d = await setup();
    await handleInbound(service(), { orgId: d.orgId, leadId: d.lead.id, channel: "sms", body: "I'd like to come in this week" });
    advance(21_000);
    await drain();
    let ms = await messagesFor(d.lead.id);
    const offer = ms.filter((m) => m.author === "ai" && m.status === "sent").at(-1);
    expect(offer.body).toMatch(/Would .+ or .+ work/);
    await handleInbound(service(), { orgId: d.orgId, leadId: d.lead.id, channel: "sms", body: "The first one works" });
    advance(21_000);
    await drain();
    const appt = await one<any>(service(), "select * from appointments where lead_id = $1", [d.lead.id]);
    expect(appt.status).toBe("booked");
    ms = await messagesFor(d.lead.id);
    const conf = ms.filter((m) => m.purpose === "confirmation").at(-1);
    expect(conf.status).toBe("sent");
    expect(conf.body).toMatch(/100 W Lake St/);
    expect((await one<any>(service(), "select stage from leads where id = $1", [d.lead.id])).stage).toBe("appointment_set");
    // appointment_set enqueues a Conversions API event and a CRM push
    expect(await q(service(), "select 1 from capi_events where lead_id = $1 and event_name = 'appointment_set'", [d.lead.id])).toHaveLength(1);
    expect(await q(service(), "select 1 from jobs where lead_id = $1 and kind = 'crm_push'", [d.lead.id])).not.toHaveLength(0);
  });

  it("24-hour and 2-hour reminders respect send windows", async () => {
    const d = await setup();
    // Appointment Saturday 09:00 CDT → 24h reminder Fri 09:00 (in window), 2h reminder Sat 07:00 (outside; 8am clamp → skipped or deferred before start)
    const start = new Date("2026-10-17T14:00:00Z");
    const r = await bookSlot({ orgId: d.orgId, leadId: d.lead.id, slot: { start, end: new Date(start.getTime() + 45 * 60_000), userId: d.lead.assigned_user_id }, createdBy: "test" });
    expect(r.ok).toBe(true);
    await runFor(start.getTime() - now().getTime(), 3600_000);
    const reminders = (await messagesFor(d.lead.id)).filter((m) => m.purpose === "reminder" && m.status === "sent");
    const w = effectiveWindow({ playbookWindow: { start: "09:00", end: "20:00", sundays: false }, orgSendSundays: false, orgSendHolidays: false });
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    for (const m of reminders) {
      if (m.channel === "sms") expect(isWithinWindow(m.sent_at, ["America/Chicago"], w), m.sent_at.toISOString()).toBe(true);
      expect(m.sent_at.getTime()).toBeLessThan(start.getTime());
    }
    expect(reminders[0].sent_at.toISOString()).toBe("2026-10-16T14:00:00.000Z");
  });

  it("no-show gets a reschedule message the next morning", async () => {
    const d = await setup();
    const start = new Date("2026-10-15T15:00:00Z");
    const r = (await bookSlot({ orgId: d.orgId, leadId: d.lead.id, slot: { start, end: new Date(start.getTime() + 45 * 60_000), userId: d.lead.assigned_user_id }, createdBy: "test" })) as any;
    setNow("2026-10-15T18:00:00Z");
    await drain();
    expect(await q(service(), "select 1 from notifications where kind = 'appointment_outcome' and channel = 'in_app'")).toHaveLength(1);
    await markAppointment(service(), r.appointment.id, "no_show", "rep");
    await runFor(24 * 3600_000, 3600_000);
    const msg = (await messagesFor(d.lead.id)).filter((m) => m.author === "ai" && m.status === "sent").at(-1);
    expect(msg.sent_at.toISOString()).toBe("2026-10-16T15:00:00.000Z"); // Fri 10:00 CDT
    expect(msg.body).toMatch(/missed you/i);
  });
});

describe("handoff", () => {
  it("alerts the rep within 30 seconds and escalates at 10 minutes", async () => {
    const d = await setup();
    const t0 = now().getTime();
    await handleInbound(service(), { orgId: d.orgId, leadId: d.lead.id, channel: "sms", body: "How much is the X5 lease per month?" });
    advance(20_000);
    await drain();
    const alert = await one<any>(service(), "select * from notifications where kind = 'handoff' and channel = 'sms'");
    expect(alert.user_id).toBe(d.lead.assigned_user_id);
    expect(alert.created_at.getTime() - t0).toBeLessThanOrEqual(30_000);
    expect(env.outbox().some((o) => o.channel === "sms" && (o.payload as any).to === alert.to_address)).toBe(true);
    expect((await one<any>(service(), "select ai_status from leads where id = $1", [d.lead.id])).ai_status).toBe("paused");
    // bridge message names the rep
    const bridge = (await messagesFor(d.lead.id)).find((m) => m.purpose === "bridge");
    expect(bridge.body).toMatch(/looping in (Sam|Alex)/);
    // 10 business minutes, no rep reply → backup alerted
    advance(10 * 60_000);
    await drain();
    expect(await q(service(), "select 1 from notifications where kind = 'sla_miss' and user_id = $1", [d.ownerId])).not.toHaveLength(0);
    // 30 minutes → the AI resumes and offers times
    advance(20 * 60_000);
    await drain();
    const l = await one<any>(service(), "select ai_status from leads where id = $1", [d.lead.id]);
    expect(l.ai_status).toBe("active");
    const resumed = (await messagesFor(d.lead.id)).filter((m) => m.author === "ai" && m.status === "sent").at(-1);
    expect(resumed.body).toMatch(/Would .+ or .+ work/);
  });

  it("a rep reply before the SLA stops escalation", async () => {
    const d = await setup();
    await handoff(service(), d.lead.id, "asks for a person");
    advance(5 * 60_000);
    await sendAsRep(service(), { leadId: d.lead.id, userId: d.lead.assigned_user_id, channel: "sms", body: "Hi, Sam here!" });
    advance(60 * 60_000);
    await drain();
    expect(await q(service(), "select 1 from notifications where kind = 'sla_miss'")).toHaveLength(0);
    expect((await one<any>(service(), "select ai_status from leads where id = $1", [d.lead.id])).ai_status).toBe("paused");
  });
});

describe("CRM push", () => {
  it("emails a valid ADF document to the CRM address on qualified", async () => {
    const d = await setup();
    await q(service(), "insert into integrations (org_id, kind, status, config) values ($1, 'adf_email', 'connected', '{\"address\":\"leads@crm.example.com\"}')", [d.orgId]);
    await setStage(service(), d.lead.id, "qualified", "test");
    await drain();
    const mail = env.outbox().find((o) => o.channel === "email" && (o.payload as any).to === "leads@crm.example.com");
    expect(mail).toBeTruthy();
    expect((mail!.payload as any).text).toMatch(/<adf>[\s\S]*<prospect status="new">[\s\S]*Maria/);
  });
});
