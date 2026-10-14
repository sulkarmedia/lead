import { describe, expect, it } from "vitest";
import { moneyClaims, runGuards, unsupportedMoneyClaims, sensitiveRequests } from "@/lib/agent/guards";
import type { AgentOutput } from "@/lib/agent/schema";

const out = (body: string, o: Partial<AgentOutput> = {}): AgentOutput => ({
  action: "reply", message: { channel: "sms", subject: null, body }, extracted: [], intent: "question", warm: false,
  book_slot_id: null, handoff_reason: null, stage_suggestion: null, confidence: 0.9, summary: "", ...o,
});
const ctx = { trigger: "reply", businessName: "BMW of Elmhurst", knowledgeText: "Loyalty offer: $1,000 off for current BMW owners. Lease from 2.9% APR on approved credit.", neverSay: ["best deal", "lowest price"], offeredSlotIds: ["slot_a", "slot_b"], unansweredAiMessages: [], now: new Date(), isFirstMessage: false };

describe("money guard", () => {
  it("finds dollar amounts, percentages, APR, monthly figures and discounts", () => {
    expect(moneyClaims("Only $499/mo with 0.9% APR and a $2,000 rebate")).toEqual(expect.arrayContaining(["$499", "0.9%", "APR", "$2,000", "rebate"]));
    expect(moneyClaims("about 350 per month")).toEqual(["350 per month"]);
  });
  it("allows figures that appear word for word in knowledge", () => {
    expect(unsupportedMoneyClaims("Current BMW owners get $1,000 off.", ctx.knowledgeText)).toEqual([]);
    expect(unsupportedMoneyClaims("Leases start at 2.9% APR.", ctx.knowledgeText)).toEqual([]);
    expect(unsupportedMoneyClaims("Leases start at 1.9% APR.", ctx.knowledgeText)).toEqual(["1.9%"]);
  });
  it("blocks and hands off on unsupported money", () => {
    const g = runGuards(out("The X5 is $65,900 right now."), ctx);
    expect(g).toMatchObject({ ok: false, handoff: true });
    expect(g.failures).toContain("money_not_in_knowledge");
  });
});

describe("other guards", () => {
  it("SMS length", () => expect(runGuards(out("x".repeat(321)), ctx).failures).toContain("sms_too_long"));
  it("never-say list", () => expect(runGuards(out("We have the best deal in town!"), ctx).failures).toContain("never_say"));
  it.each(["What's your SSN?", "Can you share your date of birth?", "What is your annual income?", "What's your credit score?", "Last 4 of your social?"])(
    "sensitive request: %s", (b) => expect(runGuards(out(b), ctx).failures).toContain("sensitive_data_request"));
  it("does not flag social media", () => expect(sensitiveRequests("Follow us on social media")).toEqual([]));
  it("book_slot_id must be offered", () => {
    expect(runGuards(out("Booked!", { action: "book", book_slot_id: "slot_zzz" }), ctx).failures).toContain("book_slot_not_offered");
    expect(runGuards(out("Booked!", { action: "book", book_slot_id: "slot_a" }), ctx).ok).toBe(true);
  });
  it("first message must name the business and disclose the assistant", () => {
    const g = runGuards(out("Hi Maria! Want to come in?"), { ...ctx, isFirstMessage: true, trigger: "first_touch" });
    expect(g.failures).toEqual(expect.arrayContaining(["first_message_missing_business_name", "first_message_missing_ai_disclosure"]));
  });
  it("at most one unanswered AI message per 2 hours outside the cadence", () => {
    const n = new Date("2026-10-14T17:00:00Z");
    const g = runGuards(out("Hello again?"), { ...ctx, trigger: "reply", now: n, unansweredAiMessages: [new Date(n.getTime() - 3600_000)] });
    expect(g.failures).toContain("unanswered_ai_message_within_2h");
    expect(runGuards(out("Hello again?"), { ...ctx, trigger: "followup", now: n, unansweredAiMessages: [new Date(n.getTime() - 3600_000)] }).ok).toBe(true);
  });
});
