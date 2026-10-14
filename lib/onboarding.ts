// Per-customer onboarding: the ten wizard steps, their status (connected / pending approval /
// blocked, with the fix) and the go-live gate. Step data is saved per step under
// organizations.onboarding_progress[<step key>].
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { Org } from "./db/types";
import { now } from "./clock";
import { isMedicalIndustry } from "./compliance";

export const STEPS = [
  { key: "basics", title: "Business basics" },
  { key: "facebook", title: "Facebook leads" },
  { key: "consent", title: "Consent per form" },
  { key: "phone", title: "Phone number" },
  { key: "email", title: "Email" },
  { key: "hours", title: "Hours and calendar" },
  { key: "team", title: "Team" },
  { key: "playbook", title: "Playbook" },
  { key: "crm", title: "CRM push (optional)" },
  { key: "golive", title: "Test and go live" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];

export type StepState = "connected" | "pending" | "blocked" | "todo" | "optional";
export interface StepStatus { key: StepKey; title: string; state: StepState; note: string; fix: string | null }

/** Vendors that touch lead data and need a signed BAA before a medical org goes live (rule 11). */
export const BAA_VENDORS = ["Twilio", "Postmark", "Anthropic", "Supabase", "Hosting (Railway)"];

export interface Blocker { code: string; step: StepKey; message: string; fix: string }

export interface GoLiveStatus {
  blockers: Blocker[];
  /** Reported, not blocking: texting turns on when carrier registration is approved. */
  textingEnabled: boolean;
  stripeRequired: boolean;
}

const stripeRequired = () => !!process.env.STRIPE_SECRET_KEY;

export function progressOf(org: Pick<Org, "onboarding_progress">): Record<string, Record<string, unknown>> {
  return (org.onboarding_progress ?? {}) as Record<string, Record<string, unknown>>;
}

/** Everything that must be true before an org can go live. Empty array = ready. */
export async function goLiveBlockers(db: Db, orgId: string): Promise<Blocker[]> {
  return (await goLiveStatus(db, orgId)).blockers;
}

export async function goLiveStatus(db: Db, orgId: string): Promise<GoLiveStatus> {
  const org = await one<Org>(db, "select * from organizations where id = $1", [orgId]);
  const blockers: Blocker[] = [];
  if (isMedicalIndustry(org.industry) && !org.hipaa_baa_confirmed_at) {
    blockers.push({
      code: "hipaa_baa_missing", step: "basics",
      message: "Healthcare businesses can't go live until HIPAA business associate agreements are signed with every vendor that touches lead data.",
      fix: `Sign BAAs with ${BAA_VENDORS.join(", ")}; the Leadline team then confirms them on your account.`,
    });
  }
  const consent = await maybeOne(db,
    `select 1 from lead_sources where org_id = $1 and active and consent_verified_at is not null and coalesce(trim(consent_text), '') <> '' limit 1`, [orgId]);
  if (!consent) {
    blockers.push({
      code: "no_verified_consent", step: "consent",
      message: "No lead form has a verified consent disclosure, so no lead can get automated texts.",
      fix: "Paste each form's SMS consent text in the Consent step and confirm it appears on the form.",
    });
  }
  const pb = await maybeOne(db, "select 1 from playbooks where org_id = $1 and approved_at is not null limit 1", [orgId]);
  if (!pb) {
    blockers.push({ code: "playbook_not_approved", step: "playbook", message: "No approved playbook.", fix: "Review the playbook and click Approve." });
  }
  if (!org.address?.trim()) {
    blockers.push({
      code: "address_missing", step: "basics",
      message: "Business address is missing. Every email must carry the business's physical address.",
      fix: "Add the street address in Business basics.",
    });
  }
  if (stripeRequired()) {
    const status = String(progressOf(org).stripe_subscription_status ?? "");
    if (!["active", "trialing"].includes(status)) {
      blockers.push({
        code: "subscription_inactive", step: "golive",
        message: `No active subscription${status ? ` (status: ${status})` : ""}.`,
        fix: "Start the subscription from the billing link we sent, then come back here.",
      });
    }
  }
  return { blockers, textingEnabled: org.texting_enabled, stripeRequired: stripeRequired() };
}

/** Sets status = 'live' only when there are no blockers. */
export async function goLive(db: Db, orgId: string): Promise<{ ok: true } | { ok: false; blockers: Blocker[] }> {
  const blockers = await goLiveBlockers(db, orgId);
  if (blockers.length) return { ok: false, blockers };
  await q(db, "update organizations set status = 'live', onboarding_progress = onboarding_progress || jsonb_build_object('went_live_at', $2::text) where id = $1",
    [orgId, now().toISOString()]);
  return { ok: true };
}

/** Merge one step's data into onboarding_progress[step] (with saved_at). */
export async function saveStepProgress(db: Db, orgId: string, step: string, data: Record<string, unknown>): Promise<void> {
  await q(db,
    `update organizations set onboarding_progress = onboarding_progress || jsonb_build_object($2::text, coalesce(onboarding_progress -> $2, '{}'::jsonb) || $3::jsonb) where id = $1`,
    [orgId, step, JSON.stringify({ ...data, saved_at: now().toISOString() })]);
}

/** Set a top-level onboarding_progress key (e.g. inventory_feed_url). */
export async function setProgressKey(db: Db, orgId: string, key: string, value: unknown): Promise<void> {
  await q(db, "update organizations set onboarding_progress = onboarding_progress || jsonb_build_object($2::text, $3::jsonb) where id = $1",
    [orgId, key, JSON.stringify(value)]);
}

/** Pre-filled carrier-registration sample messages (the brand name must appear; opt-out language included). */
export function sampleMessages(orgName: string): string[] {
  return [
    `Hi Maria, this is the virtual assistant at ${orgName}. Thanks for your request! Are you hoping to come in this week or just looking for now? Reply STOP to opt out.`,
    `${orgName}: You're all set for Thursday at 2:00pm. Reply C to confirm or R to reschedule. Reply STOP to opt out.`,
    `Hi Maria, just checking in from ${orgName}. Is there anything I can answer for you? Reply STOP to opt out.`,
  ];
}

export interface StepFacts {
  org: Org;
  sources: Array<{ consent_text: string | null; consent_covers_automated: boolean; consent_verified_at: Date | null; active: boolean }>;
  leadCount: number;
  integrations: Array<{ kind: string; status: string; user_id: string | null }>;
  hasOrgAvailability: boolean;
  members: Array<{ role: string; mobile_phone: string | null; active: boolean; notify_sms: boolean }>;
  playbooks: Array<{ approved_at: Date | null }>;
  blockers: Blocker[];
}

export async function loadStepFacts(db: Db, orgId: string): Promise<StepFacts> {
  const org = await one<Org>(db, "select * from organizations where id = $1", [orgId]);
  const [sources, leads, integrations, avail, members, playbooks, status] = await Promise.all([
    q<StepFacts["sources"][number]>(db, "select consent_text, consent_covers_automated, consent_verified_at, active from lead_sources where org_id = $1", [orgId]),
    one<{ n: number }>(db, "select count(*)::int as n from leads where org_id = $1", [orgId]),
    q<StepFacts["integrations"][number]>(db, "select kind::text, status::text, user_id from integrations where org_id = $1", [orgId]),
    maybeOne(db, "select 1 from availability where org_id = $1 and user_id is null", [orgId]),
    q<StepFacts["members"][number]>(db, "select role::text, mobile_phone, active, notify_sms from memberships where org_id = $1", [orgId]),
    q<{ approved_at: Date | null }>(db, "select approved_at from playbooks where org_id = $1", [orgId]),
    goLiveStatus(db, orgId),
  ]);
  return { org, sources, leadCount: leads.n, integrations, hasOrgAvailability: !!avail, members, playbooks, blockers: status.blockers };
}

/** Pure: each wizard step's state with a one-line note and the fix when it isn't done. */
export function computeSteps(f: StepFacts): StepStatus[] {
  const p = progressOf(f.org);
  const integ = (kind: string) => f.integrations.find((i) => i.kind === kind && !i.user_id);
  const blockerFor = (step: StepKey) => f.blockers.filter((b) => b.step === step && b.code !== "subscription_inactive");
  const s = (key: StepKey, state: StepState, note: string, fix: string | null = null): StepStatus =>
    ({ key, title: STEPS.find((x) => x.key === key)!.title, state, note, fix });
  const out: StepStatus[] = [];

  const basicsBlock = blockerFor("basics");
  const basicsDone = !!(f.org.name && f.org.website_url && f.org.timezone && f.org.industry && f.org.address);
  out.push(basicsBlock.length ? s("basics", "blocked", basicsBlock[0].message, basicsBlock[0].fix)
    : basicsDone ? s("basics", "connected", `${f.org.industry} · ${f.org.timezone}`) : s("basics", "todo", "Name, website, time zone, industry and address.", "Fill in the missing details."));

  const meta = integ("meta");
  out.push(meta?.status === "connected" ? s("facebook", "connected", "Facebook Page connected.")
    : f.leadCount > 0 ? s("facebook", "connected", `Receiving leads (${f.leadCount} so far) through the Zapier bridge.`)
    : p.facebook?.saved_at ? s("facebook", "pending", "Waiting for the first lead from Zapier.", "Send a test lead from the Zap (Zapier's “Test” button).")
    : s("facebook", "todo", "Connect your Facebook lead forms through Zapier.", "Create the Zap and paste the intake URL."));

  const active = f.sources.filter((x) => x.active);
  const verified = active.filter((x) => x.consent_verified_at && x.consent_text?.trim());
  const unverified = active.length - verified.length;
  out.push(active.length === 0 ? s("consent", "todo", "No lead forms yet.", "Add each lead form and paste its consent disclosure.")
    : verified.length === 0 ? s("consent", "blocked", "No form has a verified consent disclosure; automated texts are refused.", "Paste each form's disclosure text and confirm it.")
    : unverified > 0 ? s("consent", "pending", `${verified.length} verified, ${unverified} without consent (email only).`, "Verify the remaining forms or leave them email-only.")
    : s("consent", "connected", `${verified.length} form${verified.length === 1 ? "" : "s"} verified.`));

  out.push(f.org.texting_enabled ? s("phone", "connected", `Texting on${f.org.sms_from_number ? ` from ${f.org.sms_from_number}` : ""}.`)
    : p.phone?.submitted_at ? s("phone", "pending", "Carrier registration submitted. Texting turns on when it's approved (days to weeks).", null)
    : s("phone", "todo", "Carrier registration details needed before texting can turn on.", "Fill in the registration details."));

  const pmd = integ("postmark_domain");
  out.push(pmd?.status === "pending" ? s("email", "pending", "Custom domain waiting on DNS verification.", "Add the DNS records shown and wait for verification.")
    : pmd?.status === "error" ? s("email", "blocked", "Custom domain verification failed.", "Check the DNS records.")
    : s("email", "connected", pmd?.status === "connected" ? "Sending from your verified domain." : "Sending from the app's domain under your business name."));

  out.push(f.hasOrgAvailability ? s("hours", "connected", "Bookable hours set.") : s("hours", "todo", "Set bookable hours and slot length.", "Save your weekly hours."));

  const activeMembers = f.members.filter((m) => m.active);
  const withPhone = activeMembers.filter((m) => m.mobile_phone && m.notify_sms);
  out.push(withPhone.length > 0 ? s("team", "connected", `${activeMembers.length} member${activeMembers.length === 1 ? "" : "s"}, ${withPhone.length} with handoff texts.`)
    : s("team", "pending", "Nobody gets handoff alerts by text yet.", "Add a mobile number for at least one person."));

  out.push(f.playbooks.some((x) => x.approved_at) ? s("playbook", "connected", "Playbook approved.")
    : f.playbooks.length ? s("playbook", "pending", "Playbook drafted, waiting for your approval.", "Review it and click Approve.")
    : s("playbook", "todo", "No playbook yet.", "Enter your website to draft one."));

  const crm = f.integrations.filter((i) => (i.kind === "adf_email" || i.kind === "crm_webhook") && !i.user_id);
  out.push(crm.some((i) => i.status === "error") ? s("crm", "blocked", "A CRM push is failing.", "Check the address or URL in Integrations.")
    : crm.some((i) => i.status === "connected") ? s("crm", "connected", "Leads are pushed to your CRM.") : s("crm", "optional", "Optional: ADF/XML email or a webhook."));

  out.push(f.org.status === "live" ? s("golive", "connected", "Live.")
    : f.blockers.length ? s("golive", "blocked", `${f.blockers.length} thing${f.blockers.length === 1 ? "" : "s"} to fix before going live.`, f.blockers[0].fix)
    : s("golive", "todo", "Ready: test in the simulator, then go live."));
  return out;
}
