// Guards run in code after every agent call. Any failure blocks the send; the caller falls back to a
// handoff or no send. These are deliberately simple and deterministic.
import type { AgentOutput } from "./schema";

export const SMS_MAX = 320;

export interface GuardContext {
  trigger: string;
  businessName: string;
  knowledgeText: string;
  neverSay: string[];
  offeredSlotIds: string[];
  /** AI outbound messages since the lead's last inbound, with their send times. */
  unansweredAiMessages: Date[];
  now: Date;
  isFirstMessage: boolean;
}

export interface GuardResult {
  ok: boolean;
  failures: string[];
  /** Failures where the right fallback is a handoff to a person (vs. just not sending). */
  handoff: boolean;
  details: Record<string, unknown>;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Every money-like claim in a message: dollar amounts, percentages, APR, per-month figures, discounts. */
export function moneyClaims(body: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|thousand|million))?/g,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b)/gi,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|bucks|usd)\b/gi,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:\/\s?mo(?:nth)?\b|per month\b|a month\b|monthly\b)/gi,
    /\b(?:apr|apy|interest rate|financing rate|money factor)\b/gi,
    /\b(?:discount|rebate|incentive|markdown|cash back|cashback|\d+\s?off)\b/gi,
  ];
  for (const re of patterns) for (const m of body.matchAll(re)) out.add(m[0].trim());
  return [...out];
}

/** Money claims that don't appear word for word in the knowledge base. */
export function unsupportedMoneyClaims(body: string, knowledgeText: string): string[] {
  const k = norm(knowledgeText).replace(/,/g, "");
  return moneyClaims(body).filter((c) => !k.includes(norm(c).replace(/,/g, "")));
}

const SENSITIVE = [
  /\bssn\b/i, /\bsocial security\b/i, /\bsocial\b(?!\s+(media|proof|channels?|accounts?|pages?))/i, /\bdate of birth\b/i, /\bdob\b/i,
  /\bbirth ?date\b/i, /\bincome\b/i, /\bsalary\b/i, /\bpaystubs?\b/i, /\bcredit score\b/i, /\bcredit history\b/i, /\bcredit report\b/i,
  /\bbank account\b/i, /\brouting number\b/i,
];

export function sensitiveRequests(body: string): string[] {
  return SENSITIVE.filter((r) => r.test(body)).map((r) => r.source);
}

export function neverSayHits(body: string, neverSay: string[]): string[] {
  const b = norm(body);
  return neverSay.filter((t) => t.trim() && b.includes(norm(t)));
}

export function runGuards(o: AgentOutput, ctx: GuardContext): GuardResult {
  const failures: string[] = [];
  const details: Record<string, unknown> = {};
  let handoff = false;
  const body = o.message?.body ?? "";
  const sending = (o.action === "reply" || o.action === "book" || o.action === "handoff" || o.action === "stop") && body.trim().length > 0;

  if (o.action === "book") {
    if (!o.book_slot_id || !ctx.offeredSlotIds.includes(o.book_slot_id)) {
      failures.push("book_slot_not_offered");
      handoff = true;
    }
  }

  if (sending) {
    if (o.message!.channel === "sms" && body.length > SMS_MAX) failures.push("sms_too_long");

    const money = unsupportedMoneyClaims(body + " " + (o.message!.subject ?? ""), ctx.knowledgeText);
    if (money.length) {
      failures.push("money_not_in_knowledge");
      details.money = money;
      handoff = true;
    }
    const ns = neverSayHits(body + " " + (o.message!.subject ?? ""), ctx.neverSay);
    if (ns.length) {
      failures.push("never_say");
      details.never_say = ns;
    }
    const sens = sensitiveRequests(body);
    if (sens.length) {
      failures.push("sensitive_data_request");
      details.sensitive = sens;
      handoff = true;
    }
    if (ctx.isFirstMessage) {
      if (!norm(body).includes(norm(ctx.businessName))) failures.push("first_message_missing_business_name");
      if (!/assistant|asistente/i.test(body)) failures.push("first_message_missing_ai_disclosure");
    }
    // At most one unanswered AI message per 2 hours outside the scheduled cadence.
    const cadence = ctx.trigger === "first_touch" || ctx.trigger === "followup";
    if (!cadence) {
      const recent = ctx.unansweredAiMessages.filter((d) => ctx.now.getTime() - d.getTime() < 2 * 3600_000);
      if (recent.length >= 1) failures.push("unanswered_ai_message_within_2h");
    }
  }
  return { ok: failures.length === 0, failures, handoff, details };
}
