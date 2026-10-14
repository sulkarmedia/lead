import { describe, expect, it } from "vitest";
import { evaluate, type ComplianceFacts } from "@/lib/compliance";

const base = (): ComplianceFacts => ({
  org: { status: "live", industry: "automotive", texting_enabled: true, send_sundays: true, send_holidays: true, hipaa_baa_confirmed_at: null, sms_from_number: "+16305550100", timezone: "America/Chicago", address: "1 Main St", name: "Dealer" },
  lead: { phone_e164: "+16305550199", email: "a@b.com", opted_out_sms_at: null, opted_out_email_at: null, deleted_at: null, timezone: "America/Chicago", timezone_candidates: ["America/Chicago"], us_state: "IL", split_arm: "agent" },
  playbookWindow: { start: "09:00", end: "20:00" },
  smsConsent: { id: "c1", covers_automated: true },
  automatedSentLast24h: 0,
  onDoNotContact: false,
  at: new Date("2026-10-14T17:00:00Z"), // noon CDT
  dryRun: false,
});
const auto = { channel: "sms" as const, automated: true, isReply: false };

describe("compliance gate", () => {
  it("allows a consented automated text in the window", () => {
    const r = evaluate(auto, base());
    expect(r.ok).toBe(true);
    expect(r.consentRecordId).toBe("c1");
  });
  it("requires consent that covers automated texts", () => {
    expect(evaluate(auto, { ...base(), smsConsent: null }).reason).toBe("no_sms_consent");
    expect(evaluate(auto, { ...base(), smsConsent: { id: "c", covers_automated: false } }).reason).toBe("no_sms_consent");
    // email still allowed without SMS consent
    expect(evaluate({ ...auto, channel: "email" }, { ...base(), smsConsent: null }).ok).toBe(true);
  });
  it("blocks after an SMS opt-out, except the one confirmation", () => {
    const f = { ...base(), lead: { ...base().lead, opted_out_sms_at: new Date() } };
    expect(evaluate(auto, f).reason).toBe("opted_out_sms");
    expect(evaluate({ ...auto, automated: false }, f).reason).toBe("opted_out_sms"); // reps too
    expect(evaluate({ ...auto, purpose: "opt_out_confirmation" }, f).ok).toBe(true);
    expect(evaluate({ ...auto, channel: "email" }, f).ok).toBe(true);
  });
  it("blocks email after an all-channel opt-out", () => {
    const f = { ...base(), lead: { ...base().lead, opted_out_email_at: new Date() } };
    expect(evaluate({ ...auto, channel: "email" }, f).reason).toBe("opted_out_email");
  });
  it("blocks outside the window and reports when it opens", () => {
    const r = evaluate(auto, { ...base(), at: new Date("2026-10-15T02:00:00Z") });
    expect(r.reason).toBe("outside_send_window");
    expect(r.retryAt!.toISOString()).toBe("2026-10-15T14:00:00.000Z");
  });
  it("rep texts use the hard 08:00-21:00 limits", () => {
    const at830 = new Date("2026-10-14T13:30:00Z");
    expect(evaluate(auto, { ...base(), at: at830 }).ok).toBe(false);
    expect(evaluate({ ...auto, automated: false }, { ...base(), at: at830 }).ok).toBe(true);
  });
  it("caps automated messages at 3 per 24h, replies excluded", () => {
    expect(evaluate(auto, { ...base(), automatedSentLast24h: 2 }).ok).toBe(true);
    expect(evaluate(auto, { ...base(), automatedSentLast24h: 3 }).reason).toBe("frequency_cap");
    expect(evaluate({ ...auto, isReply: true }, { ...base(), automatedSentLast24h: 3 }).ok).toBe(true);
  });
  it("texting stays off until carrier registration (outside dry-run)", () => {
    const f = { ...base(), org: { ...base().org, texting_enabled: false } };
    expect(evaluate(auto, f).reason).toBe("texting_not_enabled");
    expect(evaluate(auto, { ...f, dryRun: true }).ok).toBe(true);
  });
  it("blocks medical orgs without BAAs", () => {
    expect(evaluate(auto, { ...base(), org: { ...base().org, industry: "Medical Spa" } }).reason).toBe("hipaa_baa_missing");
    expect(evaluate(auto, { ...base(), org: { ...base().org, industry: "medical_spa", hipaa_baa_confirmed_at: new Date() } }).ok).toBe(true);
  });
  it("blocks do-not-contact, deleted leads, non-live orgs and control-arm leads", () => {
    expect(evaluate(auto, { ...base(), onDoNotContact: true }).reason).toBe("do_not_contact");
    expect(evaluate(auto, { ...base(), lead: { ...base().lead, deleted_at: new Date() } }).reason).toBe("lead_deleted");
    expect(evaluate(auto, { ...base(), org: { ...base().org, status: "onboarding" } }).reason).toBe("org_not_live");
    expect(evaluate(auto, { ...base(), lead: { ...base().lead, split_arm: "control" } }).reason).toBe("control_arm");
  });
  it("emails require the business address", () => {
    expect(evaluate({ ...auto, channel: "email" }, { ...base(), org: { ...base().org, address: null } }).reason).toBe("no_business_address");
  });
});
