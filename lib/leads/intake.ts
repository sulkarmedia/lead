// Intake for every lead source: Meta webhook, Zapier bridge, generic webhook, CSV, manual entry.
// normalize → dedupe → consent snapshot → time zone → create at `new` → assign → enqueue first_touch.
import { z } from "zod";
import type { Db } from "../db";
import { maybeOne, one, q, tx } from "../db";
import type { Lead, LeadSource, Org, Playbook } from "../db/types";
import { now } from "../clock";
import { phoneHash, sha256 } from "../crypto";
import { resolveTimezone } from "../compliance/geo";
import { enqueue } from "../jobs";
import { log } from "../log";
import { assignRep } from "./assign";
import { mapAnswers, normalizeEmail, normalizePhone, splitName } from "./normalize";
import { enqueueWebhook, setStage } from "./stages";

const str = z.union([z.string(), z.number()]).transform((v) => String(v)).optional().nullable();

export const IntakeLead = z
  .object({
    meta_lead_id: str,
    form_id: str,
    page_id: str,
    campaign_id: str, campaign_name: str,
    adset_id: str, adset_name: str,
    ad_id: str, ad_name: str,
    full_name: str, first_name: str, last_name: str,
    phone: str, phone_number: str,
    email: str,
    zip: str, zip_code: str, post_code: str,
    created_time: str,
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type IntakeLead = z.infer<typeof IntakeLead>;

const KNOWN = new Set(Object.keys(IntakeLead.shape));

export type IntakeResult =
  | { status: "created"; leadId: string }
  | { status: "duplicate"; leadId: string }
  | { status: "resubmitted"; leadId: string }
  | { status: "rejected"; reason: string };

const DEDUPE_DAYS = 30;

export async function ingestLead(orgId: string, sourceId: string, raw: unknown, actor = "intake"): Promise<IntakeResult> {
  const parsed = IntakeLead.safeParse(raw);
  if (!parsed.success) return { status: "rejected", reason: parsed.error.issues.map((i) => i.message).join("; ") };
  const input = parsed.data;

  // Unknown top-level keys from Zapier/webhooks are form answers.
  const answers: Record<string, unknown> = { ...(input.answers ?? {}) };
  for (const [k, v] of Object.entries(input)) if (!KNOWN.has(k)) answers[k] = v;

  const phone = normalizePhone(input.phone ?? input.phone_number);
  const email = normalizeEmail(input.email);
  if (!phone && !email) return { status: "rejected", reason: "no valid phone or email" };
  const names = splitName(input.full_name, input.first_name, input.last_name);
  const zip = (input.zip ?? input.zip_code ?? input.post_code ?? "").trim().slice(0, 10) || null;

  const result = await tx(async (c) => {
    const org = await one<Org>(c, "select * from organizations where id = $1", [orgId]);
    const source = await one<LeadSource>(c, "select * from lead_sources where id = $1 and org_id = $2", [sourceId, orgId]);
    const playbook = source.playbook_id
      ? await maybeOne<Playbook>(c, "select * from playbooks where id = $1", [source.playbook_id])
      : await maybeOne<Playbook>(c, "select * from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [orgId]);

    // 1. Same Meta lead id: ignore.
    if (input.meta_lead_id) {
      const dup = await maybeOne<{ id: string }>(c, "select id from leads where org_id = $1 and meta_lead_id = $2", [orgId, input.meta_lead_id]);
      if (dup) return { status: "duplicate", leadId: dup.id } as IntakeResult;
    }

    // 2. Same phone within 30 days: attach as a re-submission, reactivate if lost/nurture.
    if (phone) {
      const since = new Date(now().getTime() - DEDUPE_DAYS * 86400_000);
      const prior = await maybeOne<Lead>(
        c, "select * from leads where org_id = $1 and phone_e164 = $2 and created_at > $3 and deleted_at is null order by created_at desc limit 1 for update",
        [orgId, phone, since]);
      if (prior) {
        await q(c, `update leads set resubmitted_at = $2, answers = answers || $3::jsonb, email = coalesce(email, $4) where id = $1`,
          [prior.id, now(), JSON.stringify(answers), email]);
        await q(c, `insert into messages (org_id, lead_id, channel, direction, author, body, status, purpose, created_at)
                    values ($1, $2, 'system', 'internal', 'system', $3, 'received', 'resubmission', $4)`,
          [orgId, prior.id, `Lead submitted the form again${input.form_id ? ` (form ${input.form_id})` : ""}.`, now()]);
        if (prior.stage === "lost" || prior.stage === "nurture") {
          await setStage(c, prior.id, "engaged", "resubmission");
          await q(c, "update leads set ai_status = case when ai_status = 'stopped' and opted_out_sms_at is null then 'active' else ai_status end, cadence_kind = 'no_reply', cadence_step = 0 where id = $1", [prior.id]);
          await enqueue(c, { orgId, leadId: prior.id, kind: "first_touch", payload: { resubmission: true }, dedupeKey: `first_touch:${prior.id}` });
        }
        return { status: "resubmitted", leadId: prior.id } as IntakeResult;
      }
    }

    const tz = resolveTimezone({ zip, phone, orgTimezone: org.timezone });
    const qualification = playbook ? mapAnswers(answers, playbook.qualification_fields, source.field_mapping) : {};
    const assigned = await assignRep(c, orgId);
    // 50/50 pilot measurement: a stable split by lead identity.
    const armKey = input.meta_lead_id ?? phone ?? email ?? "";
    const arm = Number.parseInt(sha256(armKey).slice(0, 8), 16) % 100 < org.agent_split_percent ? "agent" : "control";

    const lead = await one<{ id: string }>(
      c,
      `insert into leads (org_id, source_id, meta_lead_id, meta_form_id, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
                          first_name, last_name, full_name, phone_e164, email, zip, us_state, timezone, timezone_candidates,
                          answers, qualification, assigned_user_id, split_arm, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
      [
        orgId, sourceId, input.meta_lead_id ?? null, input.form_id ?? source.meta_form_id, input.campaign_id ?? null, input.campaign_name ?? null,
        input.adset_id ?? null, input.adset_name ?? null, input.ad_id ?? null, input.ad_name ?? null,
        names.first_name, names.last_name, names.full_name, phone, email, zip, tz.usState, tz.timezone, JSON.stringify(tz.candidates),
        JSON.stringify(answers), JSON.stringify(qualification), assigned, arm, now(),
      ],
    );
    await q(c, "insert into stage_events (org_id, lead_id, from_stage, to_stage, actor, created_at) values ($1, $2, null, 'new', $3, $4)", [orgId, lead.id, actor, now()]);

    // Consent snapshot: only when the source has a verified disclosure. Otherwise the lead is email-only.
    if (phone && source.consent_text && source.consent_verified_at) {
      await q(
        c,
        `insert into consent_records (org_id, lead_id, channel, source, disclosure_text, covers_automated, captured_at, evidence)
         values ($1, $2, 'sms', $3, $4, $5, $6, $7)`,
        [orgId, lead.id, `${source.kind}:${source.id}`, source.consent_text, source.consent_covers_automated, input.created_time ? new Date(input.created_time) : now(),
          JSON.stringify({ meta_lead_id: input.meta_lead_id ?? null, form_id: input.form_id ?? source.meta_form_id, phone, source_name: source.name, consent_verified_at: source.consent_verified_at })],
      );
    }
    if (email) {
      await q(c, `insert into consent_records (org_id, lead_id, channel, source, disclosure_text, covers_automated, captured_at, evidence)
                  values ($1, $2, 'email', $3, $4, false, $5, $6)`,
        [orgId, lead.id, `${source.kind}:${source.id}`, "Lead submitted their email address on the form and requested follow-up.", now(), JSON.stringify({ form_id: input.form_id ?? null })]);
    }

    // Previously deleted at the lead's request: keep the record, never contact.
    const dnc = phone ? await maybeOne(c, "select 1 from do_not_contact where org_id = $1 and phone_hash = $2", [orgId, phoneHash(phone)]) : null;
    if (dnc) {
      await q(c, "update leads set ai_status = 'stopped', ai_paused_reason = 'do_not_contact', opted_out_sms_at = $2, opted_out_email_at = $2 where id = $1", [lead.id, now()]);
    } else if (arm === "agent") {
      await enqueue(c, { orgId, leadId: lead.id, kind: "first_touch", dedupeKey: `first_touch:${lead.id}` });
    } else {
      await q(c, "update leads set ai_status = 'stopped', ai_paused_reason = 'control_arm' where id = $1", [lead.id]);
    }
    await enqueueWebhook(c, orgId, lead.id, "lead.created");
    return { status: "created", leadId: lead.id } as IntakeResult;
  });
  log.info("intake", { org_id: orgId, source_id: sourceId, ...result });
  return result;
}

/** Find or create the source row used for an intake path (zapier, webhook, csv, manual). */
export async function ensureSource(db: Db, orgId: string, kind: LeadSource["kind"], formId?: string | null, name?: string): Promise<LeadSource> {
  if (formId) {
    const s = await maybeOne<LeadSource>(db, "select * from lead_sources where org_id = $1 and meta_form_id = $2", [orgId, formId]);
    if (s) return s;
  } else {
    const s = await maybeOne<LeadSource>(db, "select * from lead_sources where org_id = $1 and kind = $2 and meta_form_id is null order by created_at limit 1", [orgId, kind]);
    if (s) return s;
  }
  const pb = await maybeOne<{ id: string }>(db, "select id from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [orgId]);
  return one<LeadSource>(
    db,
    `insert into lead_sources (org_id, kind, name, meta_form_id, playbook_id) values ($1, $2, $3, $4, $5)
     on conflict (org_id, meta_form_id) where meta_form_id is not null do update set name = lead_sources.name returning *`,
    [orgId, kind, name ?? (formId ? `Form ${formId}` : `${kind} intake`), formId ?? null, pb?.id ?? null],
  );
}
