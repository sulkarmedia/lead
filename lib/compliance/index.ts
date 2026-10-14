// The one compliance gate. Runs when a send is scheduled and again at the moment of sending.
// Nothing in the UI can switch these checks off.
import type { Db } from "../db";
import { maybeOne, one, q } from "../db";
import type { Lead, Org, Playbook } from "../db/types";
import { now } from "../clock";
import { env } from "../env";
import { phoneHash } from "../crypto";
import { effectiveWindow, hardLimitWindow, isWithinWindow, nextWindowOpen, type WindowConfig } from "./sendWindow";
import { PLATFORM_DEFAULTS, STATE_RULES } from "./state-rules";

export const MEDICAL_INDUSTRIES = ["medical", "healthcare", "clinic", "dental", "plastic_surgery", "med_spa", "medical_spa", "chiropractic", "therapy"];

export function isMedicalIndustry(industry: string): boolean {
  const i = industry.toLowerCase().replace(/[\s-]+/g, "_");
  return MEDICAL_INDUSTRIES.some((m) => i.includes(m));
}

export interface SendIntent {
  channel: "sms" | "email";
  /** Sent by the AI or the cadence (true) or typed by a rep (false). */
  automated: boolean;
  /** Answering the lead's own inbound message (excluded from the frequency cap). */
  isReply: boolean;
  /** Opt-out confirmations are the one message allowed after an opt-out. */
  purpose?: string;
}

export interface ComplianceFacts {
  org: Pick<Org, "status" | "industry" | "texting_enabled" | "send_sundays" | "send_holidays" | "hipaa_baa_confirmed_at" | "sms_from_number" | "timezone" | "address" | "name">;
  lead: Pick<Lead, "phone_e164" | "email" | "opted_out_sms_at" | "opted_out_email_at" | "deleted_at" | "timezone" | "timezone_candidates" | "us_state" | "split_arm">;
  playbookWindow: Playbook["send_window"] | null;
  smsConsent: { id: string; covers_automated: boolean } | null;
  automatedSentLast24h: number;
  onDoNotContact: boolean;
  at: Date;
  dryRun: boolean;
}

export type BlockReason =
  | "lead_deleted" | "no_phone" | "no_email" | "opted_out_sms" | "opted_out_email" | "no_sms_consent"
  | "texting_not_enabled" | "no_sms_number" | "outside_send_window" | "frequency_cap" | "do_not_contact"
  | "org_not_live" | "hipaa_baa_missing" | "no_business_address" | "control_arm";

export interface ComplianceResult {
  ok: boolean;
  reason?: BlockReason;
  /** When blocked only by the send window: the next time it would be allowed. */
  retryAt?: Date | null;
  consentRecordId?: string | null;
  window?: WindowConfig;
  checks: Record<string, boolean>;
}

export function zonesFor(lead: ComplianceFacts["lead"], orgTz: string): string[] {
  const c = lead.timezone_candidates?.length ? lead.timezone_candidates : lead.timezone ? [lead.timezone] : [orgTz];
  return Array.from(new Set(c));
}

export function maxAutomatedPer24h(usState: string | null | undefined): number {
  const rule = usState ? STATE_RULES[usState] : undefined;
  return Math.min(PLATFORM_DEFAULTS.maxAutomatedPer24h, rule?.maxAutomatedPer24h ?? Infinity);
}

/** Pure decision from already-loaded facts. */
export function evaluate(intent: SendIntent, f: ComplianceFacts): ComplianceResult {
  const checks: Record<string, boolean> = {};
  const block = (reason: BlockReason, extra: Partial<ComplianceResult> = {}): ComplianceResult => ({ ok: false, reason, checks, ...extra });
  const isOptOutConfirmation = intent.purpose === "opt_out_confirmation";

  checks.not_deleted = !f.lead.deleted_at;
  if (!checks.not_deleted) return block("lead_deleted");

  // In the 50/50 pilot measurement, control-arm leads are worked by the dealer's usual process only.
  checks.agent_arm = !(intent.automated && f.lead.split_arm === "control");
  if (!checks.agent_arm) return block("control_arm");

  checks.hipaa = !isMedicalIndustry(f.org.industry) || !!f.org.hipaa_baa_confirmed_at;
  if (!checks.hipaa) return block("hipaa_baa_missing");

  // Outside dry-run, automated messages only go out for live orgs.
  checks.org_live = f.dryRun || !intent.automated || f.org.status === "live";
  if (!checks.org_live) return block("org_not_live");

  if (intent.channel === "email") {
    checks.has_email = !!f.lead.email;
    if (!checks.has_email) return block("no_email");
    checks.email_not_opted_out = !f.lead.opted_out_email_at;
    if (!checks.email_not_opted_out) return block("opted_out_email");
    checks.business_address = !!f.org.address;
    if (!checks.business_address) return block("no_business_address");
    if (intent.automated && !intent.isReply) {
      checks.frequency_cap = f.automatedSentLast24h < maxAutomatedPer24h(f.lead.us_state);
      if (!checks.frequency_cap) return block("frequency_cap");
    }
    return { ok: true, checks };
  }

  // SMS
  checks.has_phone = !!f.lead.phone_e164;
  if (!checks.has_phone) return block("no_phone");
  checks.not_dnc = !f.onDoNotContact;
  if (!checks.not_dnc) return block("do_not_contact");
  checks.sms_not_opted_out = !f.lead.opted_out_sms_at || isOptOutConfirmation;
  if (!checks.sms_not_opted_out) return block("opted_out_sms");
  checks.texting_enabled = f.org.texting_enabled || f.dryRun;
  if (!checks.texting_enabled) return block("texting_not_enabled");
  checks.sms_number = !!f.org.sms_from_number || f.dryRun;
  if (!checks.sms_number) return block("no_sms_number");
  if (isOptOutConfirmation) return { ok: true, checks };

  if (intent.automated) {
    checks.sms_consent = !!f.smsConsent && f.smsConsent.covers_automated;
    if (!checks.sms_consent) return block("no_sms_consent");
  }

  const zones = zonesFor(f.lead, f.org.timezone);
  const window = intent.automated
    ? effectiveWindow({ playbookWindow: f.playbookWindow, orgSendSundays: f.org.send_sundays, orgSendHolidays: f.org.send_holidays, usState: f.lead.us_state })
    : hardLimitWindow(f.lead.us_state);
  checks.send_window = isWithinWindow(f.at, zones, window);
  if (!checks.send_window) return block("outside_send_window", { retryAt: nextWindowOpen(f.at, zones, window), window });

  if (intent.automated && !intent.isReply) {
    checks.frequency_cap = f.automatedSentLast24h < maxAutomatedPer24h(f.lead.us_state);
    if (!checks.frequency_cap) return block("frequency_cap");
  }
  return { ok: true, checks, consentRecordId: f.smsConsent?.id ?? null, window };
}

/** Load the facts for a lead and evaluate. */
export async function checkSend(db: Db, leadId: string, intent: SendIntent): Promise<ComplianceResult> {
  const facts = await loadFacts(db, leadId, intent.channel);
  return evaluate(intent, facts);
}

export async function loadFacts(db: Db, leadId: string, channel: "sms" | "email"): Promise<ComplianceFacts> {
  const lead = await one<Lead & { org_id: string; source_id: string | null }>(db, "select * from leads where id = $1", [leadId]);
  const org = await one<Org>(db, "select * from organizations where id = $1", [lead.org_id]);
  const pb = await maybeOne<{ send_window: Playbook["send_window"] }>(
    db,
    `select p.send_window from lead_sources s join playbooks p on p.id = s.playbook_id where s.id = $1`,
    [lead.source_id],
  );
  const consent = await maybeOne<{ id: string; covers_automated: boolean }>(
    db,
    `select id, covers_automated from consent_records where lead_id = $1 and channel = 'sms' order by captured_at desc limit 1`,
    [leadId],
  );
  const at = now();
  const since = new Date(at.getTime() - 24 * 3600_000);
  const [{ count }] = await q<{ count: number }>(
    db,
    `select count(*)::int as count from messages
      where lead_id = $1 and channel = $2 and direction = 'outbound' and is_automated and not is_reply
        and status in ('queued', 'sent', 'delivered') and coalesce(sent_at, created_at) > $3`,
    [leadId, channel, since],
  );
  const dnc = lead.phone_e164
    ? await maybeOne(db, "select 1 from do_not_contact where org_id = $1 and phone_hash = $2", [lead.org_id, phoneHash(lead.phone_e164)])
    : null;
  return {
    org,
    lead,
    playbookWindow: pb?.send_window ?? null,
    smsConsent: consent,
    automatedSentLast24h: count,
    onDoNotContact: !!dnc,
    at,
    dryRun: env.dryRun,
  };
}
