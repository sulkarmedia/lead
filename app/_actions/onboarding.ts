"use server";
// Onboarding wizard actions. Each step saves into organizations.onboarding_progress[<step>] (plus the
// real columns where they exist). Go live only flips status when goLiveBlockers() returns none.
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { z } from "zod";
import { audit, requireAdmin } from "@/lib/auth";
import { maybeOne, one, q, service } from "@/lib/db";
import type { LeadSource, Playbook } from "@/lib/db/types";
import { now } from "@/lib/clock";
import { normalizeEmail, normalizePhone } from "@/lib/leads/normalize";
import { goLive, saveStepProgress } from "@/lib/onboarding";
import {
  approvePlaybook, generatePlaybookDraft, insertKnowledgeItems, introTemplateProblems, KnowledgeDraft, normalizeSiteUrl, PlaybookInput,
  savePlaybookVersion, type PlaybookDraft,
} from "@/lib/playbook-generator";
import type { ActionResult } from "../(app)/settings/_components/ActionForm";

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : (e as Error).message });
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const bool = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "true";

const done = () => {
  revalidatePath("/onboarding");
  revalidatePath("/settings/integrations");
};

// 1. Business basics ---------------------------------------------------------------------------

export async function saveBasicsAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const name = str(form, "name");
    if (!name) return { ok: false, error: "Business name is required." };
    const tz = str(form, "timezone");
    if (!DateTime.local().setZone(tz).isValid) return { ok: false, error: "Pick a valid time zone." };
    const website = str(form, "website_url") ? normalizeSiteUrl(str(form, "website_url")) : null;
    const industry = str(form, "industry").toLowerCase().replace(/[\s-]+/g, "_").slice(0, 60) || "other";
    const rawPhone = str(form, "phone");
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) return { ok: false, error: "That business phone doesn't look valid." };
    const address = str(form, "address") || null;
    const after = { name: name.slice(0, 120), website_url: website, timezone: tz, industry, address, phone };
    await q(service(), "update organizations set name = $2, website_url = $3, timezone = $4, industry = $5, address = $6, phone = $7 where id = $1",
      [ctx.org.id, after.name, after.website_url, after.timezone, after.industry, after.address, after.phone]);
    // HIPAA BAAs are confirmed by the platform team (they hold the vendor agreements), never self-served.
    if (ctx.isPlatformAdmin && form.has("baa_present")) {
      const confirm = bool(form, "hipaa_baa_confirmed");
      await q(service(), "update organizations set hipaa_baa_confirmed_at = $2 where id = $1", [ctx.org.id, confirm ? (ctx.org.hipaa_baa_confirmed_at ?? now()) : null]);
      if (confirm !== !!ctx.org.hipaa_baa_confirmed_at) await audit(ctx, confirm ? "compliance.baa_confirm" : "compliance.baa_revoke", "organization", ctx.org.id);
    }
    await saveStepProgress(service(), ctx.org.id, "basics", {});
    await audit(ctx, "onboarding.basics", "organization", ctx.org.id, {
      before: { name: ctx.org.name, website_url: ctx.org.website_url, timezone: ctx.org.timezone, industry: ctx.org.industry, address: ctx.org.address, phone: ctx.org.phone },
      after,
    });
    done();
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

// 2. Facebook (phase 1: Zapier bridge) ------------------------------------------------------------

export async function saveFacebookAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    await saveStepProgress(service(), ctx.org.id, "facebook", { zap_created: bool(form, "zap_created"), page_name: str(form, "page_name") || null });
    await audit(ctx, "onboarding.facebook", "organization", ctx.org.id, { zap_created: bool(form, "zap_created") });
    done();
    return { ok: true, message: "Saved. Send a test lead from Zapier to confirm." };
  } catch (e) {
    return fail(e);
  }
}

// 3. Consent per form -------------------------------------------------------------------------------

export async function addSourceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const name = str(form, "name");
    if (!name) return { ok: false, error: "Name the form (as it appears in Facebook)." };
    const formId = str(form, "meta_form_id") || null;
    if (formId && !/^[\w-]{1,64}$/.test(formId)) return { ok: false, error: "The form id is the number in Facebook's form library." };
    if (formId && (await maybeOne(service(), "select 1 from lead_sources where org_id = $1 and meta_form_id = $2", [ctx.org.id, formId]))) return { ok: false, error: "That form is already listed." };
    const pb = await maybeOne<{ id: string }>(service(), "select id from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [ctx.org.id]);
    const row = await one<{ id: string }>(service(), "insert into lead_sources (org_id, kind, name, meta_form_id, playbook_id) values ($1, 'zapier', $2, $3, $4) returning id",
      [ctx.org.id, name.slice(0, 120), formId, pb?.id ?? null]);
    await audit(ctx, "onboarding.source_add", "lead_source", row.id, { name, meta_form_id: formId });
    done();
    return { ok: true, message: "Form added. Paste its consent text below." };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Store a form's consent disclosure. The snapshot is copied onto each lead at intake, so editing it
 * never rewrites history. Changing the text clears verification unless it is re-confirmed.
 */
export async function saveConsentAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const id = str(form, "source_id");
    const src = await maybeOne<LeadSource>(service(), "select * from lead_sources where id = $1 and org_id = $2", [id, ctx.org.id]);
    if (!src) return { ok: false, error: "Form not found" };
    const text = str(form, "consent_text").slice(0, 4000);
    const covers = bool(form, "consent_covers_automated");
    const verified = bool(form, "verified");
    if (verified && !text) return { ok: false, error: "Paste the disclosure text before confirming." };
    if (covers && text && !/text|sms|messag/i.test(text)) return { ok: false, error: "That disclosure doesn't mention text messages, so it can't cover automated texts." };
    const verifiedAt = verified && text ? (src.consent_verified_at && src.consent_text === text ? src.consent_verified_at : now()) : null;
    await q(service(), "update lead_sources set consent_text = $3, consent_covers_automated = $4, consent_verified_at = $5 where id = $1 and org_id = $2",
      [id, ctx.org.id, text || null, covers && !!text, verifiedAt]);
    await audit(ctx, "onboarding.consent", "lead_source", id, {
      before: { consent_text: src.consent_text, consent_covers_automated: src.consent_covers_automated, consent_verified_at: src.consent_verified_at },
      after: { consent_text: text || null, consent_covers_automated: covers && !!text, consent_verified_at: verifiedAt },
    });
    done();
    return { ok: true, message: verifiedAt ? (covers ? "Verified. Leads from this form can get automated texts." : "Verified, but it doesn't cover automated texts: these leads get email only.") : "Saved. Not verified: leads from this form get email only." };
  } catch (e) {
    return fail(e);
  }
}

// 4. Phone number: carrier registration details --------------------------------------------------

const Registration = z.object({
  legal_name: z.string().trim().min(2, "legal business name is required").max(200),
  ein: z.string().trim().regex(/^\d{2}-?\d{7}$/, "EIN looks like 12-3456789"),
  business_type: z.string().trim().max(60),
  street: z.string().trim().min(3, "street address is required").max(200),
  city: z.string().trim().min(2, "city is required").max(100),
  state: z.string().trim().regex(/^[A-Za-z]{2}$/, "state is two letters"),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP is 5 digits"),
  contact_name: z.string().trim().min(2, "contact name is required").max(120),
  contact_email: z.string().trim().email("contact email is invalid"),
  contact_phone: z.string().trim().min(7, "contact phone is required"),
  website: z.string().trim().max(300),
  area_code: z.string().trim().regex(/^(\d{3})?$/, "area code is 3 digits"),
  use_case: z.string().trim().min(20, "describe how you'll text leads (20+ characters)").max(1000),
  opt_in: z.string().trim().min(20, "describe how leads opt in (20+ characters)").max(1000),
  samples: z.array(z.string().trim().min(20).max(320)).min(2, "at least two sample messages"),
});

export async function savePhoneRegistrationAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const reg = Registration.parse({
      legal_name: str(form, "legal_name"), ein: str(form, "ein"), business_type: str(form, "business_type"), street: str(form, "street"), city: str(form, "city"),
      state: str(form, "state"), zip: str(form, "zip"), contact_name: str(form, "contact_name"), contact_email: str(form, "contact_email"),
      contact_phone: str(form, "contact_phone"), website: str(form, "website"), area_code: str(form, "area_code"), use_case: str(form, "use_case"),
      opt_in: str(form, "opt_in"), samples: [str(form, "sample_1"), str(form, "sample_2"), str(form, "sample_3")].filter(Boolean),
    });
    const phone = normalizePhone(reg.contact_phone);
    if (!phone) return { ok: false, error: "contact phone doesn't look valid" };
    const email = normalizeEmail(reg.contact_email)!;
    const missingBrand = reg.samples.filter((s) => !s.toLowerCase().includes(ctx.org.name.toLowerCase()) && !s.toLowerCase().includes(reg.legal_name.toLowerCase()));
    if (missingBrand.length) return { ok: false, error: "Each sample message must name the business." };
    const submit = str(form, "intent") === "submit";
    await saveStepProgress(service(), ctx.org.id, "phone", {
      registration: { ...reg, ein: reg.ein.replace(/^(\d{2})-?(\d{7})$/, "$1-$2"), state: reg.state.toUpperCase(), contact_phone: phone, contact_email: email },
      ...(submit ? { submitted_at: now().toISOString() } : {}),
    });
    await audit(ctx, submit ? "onboarding.phone_submit" : "onboarding.phone_save", "organization", ctx.org.id, { legal_name: reg.legal_name });
    done();
    return { ok: true, message: submit ? "Submitted. Texting turns on when the carrier approves the registration (days to weeks)." : "Saved as draft." };
  } catch (e) {
    return fail(e);
  }
}

// 5. Email ------------------------------------------------------------------------------------------

export async function saveEmailStepAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const domain = str(form, "custom_domain").toLowerCase();
    if (domain && !/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return { ok: false, error: "Enter a domain like mail.yourbusiness.com" };
    await saveStepProgress(service(), ctx.org.id, "email", { confirmed: true, custom_domain_requested: domain || null });
    await audit(ctx, "onboarding.email", "organization", ctx.org.id, { custom_domain_requested: domain || null });
    done();
    return { ok: true, message: domain ? "Saved. We'll send the DNS records for your domain." : "Saved." };
  } catch (e) {
    return fail(e);
  }
}

// 8. Playbook: website → draft → edit/approve ----------------------------------------------------

export async function generateDraftAction(url: string): Promise<{ ok: true; draft: PlaybookDraft & { pages: Array<{ url: string; title: string }> } } | { ok: false; error: string }> {
  const ctx = await requireAdmin();
  try {
    const target = normalizeSiteUrl(url || ctx.org.website_url || "");
    const draft = await generatePlaybookDraft(ctx.org, target);
    await saveStepProgress(service(), ctx.org.id, "playbook", { website_scanned: target, drafted_at: now().toISOString(), pages: draft.pages.length, fallback: draft.fallback });
    if (!ctx.org.website_url) await q(service(), "update organizations set website_url = $2 where id = $1", [ctx.org.id, target]);
    await audit(ctx, "onboarding.playbook_draft", "organization", ctx.org.id, { url: target, pages: draft.pages.length, fallback: draft.fallback });
    return { ok: true, draft };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Save the (edited) draft: playbook as a new version + the knowledge items kept. Approve optionally. */
export async function saveDraftAction(input: { playbook: unknown; knowledge_items: unknown; approve: boolean }): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const playbook = PlaybookInput.parse(input.playbook);
    const items = z.array(KnowledgeDraft).max(100).parse(input.knowledge_items);
    const problems = introTemplateProblems(playbook.intro_template, ctx.org.name);
    if (problems.length) return { ok: false, error: `Intro message ${problems.join("; ")}` };
    const current = await maybeOne<Playbook>(service(), "select * from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [ctx.org.id]);
    let saved = await savePlaybookVersion(service(), ctx.org.id, current?.id ?? null, playbook);
    const n = await insertKnowledgeItems(service(), ctx.org.id, items);
    if (input.approve) saved = (await approvePlaybook(service(), ctx.org.id, saved.id, ctx.user.id)) ?? saved;
    await audit(ctx, current ? "playbook.update" : "playbook.create", "playbook", saved.id, { version: saved.version, from: "generator", knowledge_items: n, after: playbook });
    if (input.approve) await audit(ctx, "playbook.approve", "playbook", saved.id, { version: saved.version });
    revalidatePath("/settings/playbook");
    revalidatePath("/settings/knowledge");
    done();
    return { ok: true, message: `${input.approve ? "Approved" : "Saved"} playbook v${saved.version} and ${n} knowledge item${n === 1 ? "" : "s"}.` };
  } catch (e) {
    return fail(e);
  }
}

// 10. Go live -----------------------------------------------------------------------------------------

export async function goLiveAction(_prev: ActionResult | null, _form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const r = await goLive(service(), ctx.org.id);
    if (!r.ok) return { ok: false, error: `Can't go live yet: ${r.blockers.map((b) => b.message).join(" ")}` };
    await audit(ctx, "onboarding.go_live", "organization", ctx.org.id, { from: ctx.org.status, to: "live" });
    done();
    revalidatePath("/inbox");
    return { ok: true, message: "You're live. New leads get a reply within a minute." };
  } catch (e) {
    return fail(e);
  }
}
