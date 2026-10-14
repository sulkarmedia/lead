// /onboarding: the ten-step setup wizard. Each step saves on its own (organizations.onboarding_progress
// plus the real columns) and shows connected / pending approval / blocked, with the fix. Go live flips
// the org to `live` only when lib/onboarding goLiveBlockers() returns none.
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { maybeOne, q, service, withUserDb } from "@/lib/db";
import type { Availability, LeadSource, Membership, Playbook } from "@/lib/db/types";
import { env } from "@/lib/env";
import { fmtPhone, fmtTime } from "@/lib/format";
import { DEFAULT_NO_REPLY, DEFAULT_WENT_QUIET } from "@/lib/cadence";
import { isMedicalIndustry } from "@/lib/compliance";
import { BAA_VENDORS, computeSteps, goLiveStatus, loadStepFacts, progressOf, sampleMessages, STEPS, type StepKey, type StepState } from "@/lib/onboarding";
import { Badge, ButtonLink, Card, CardTitle, Input, Label, PageHeader, Select, Textarea, cx } from "../../_components/ui";
import {
  addSourceAction, generateDraftAction, goLiveAction, saveBasicsAction, saveConsentAction, saveDraftAction, saveEmailStepAction, saveFacebookAction,
  savePhoneRegistrationAction,
} from "../../_actions/onboarding";
import { approvePlaybookAction, saveAdfAction } from "../../_actions/settings";
import { ActionForm, SubmitButton } from "../settings/_components/ActionForm";
import { CopyField } from "../settings/integrations/_components/IntegrationCard";
import { AvailabilityForm } from "../settings/hours/_components/AvailabilityForm";
import { InviteForm } from "../settings/team/_components/InviteForm";
import { DraftWizard } from "./_components/DraftWizard";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<StepState, [string, "green" | "yellow" | "red" | "gray" | "blue"]> = {
  connected: ["Done", "green"],
  pending: ["Pending approval", "yellow"],
  blocked: ["Blocked", "red"],
  todo: ["To do", "gray"],
  optional: ["Optional", "blue"],
};

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico"];
const INDUSTRIES = ["automotive", "home_services", "real_estate", "fitness", "legal", "education", "insurance", "solar", "medical", "med_spa", "dental", "plastic_surgery", "chiropractic", "other"];

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const ctx = await requireAdmin();
  const facts = await withUserDb(ctx.user.id, (c) => loadStepFacts(c, ctx.org.id));
  const steps = computeSteps(facts);
  const want = (await searchParams).step;
  const current = (STEPS.find((s) => s.key === want)?.key ?? steps.find((s) => s.state !== "connected" && s.state !== "optional")?.key ?? "golive") as StepKey;
  const st = steps.find((s) => s.key === current)!;
  const doneCount = steps.filter((s) => s.state === "connected").length;

  return (
    <div className="space-y-4">
      <PageHeader title="Setup" actions={<Badge tone={ctx.org.status === "live" ? "green" : "yellow"}>{ctx.org.status === "live" ? "Live" : "Not live yet"}</Badge>}>
        {doneCount} of {steps.length} steps done. Each step saves on its own; come back any time.
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <ol className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible" data-testid="steps">
          {steps.map((s, i) => {
            const [label, tone] = STATE_LABEL[s.state];
            return (
              <li key={s.key} className="shrink-0">
                <Link href={`/onboarding?step=${s.key}`} className={cx("flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm", s.key === current ? "bg-brand/10 font-medium text-brand" : "hover:bg-black/5 dark:hover:bg-white/10")}>
                  <span>{i + 1}. {s.title}</span>
                  <Badge tone={tone}>{label}</Badge>
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="min-w-0 space-y-4">
          <Card className={cx("space-y-1", st.state === "blocked" && "border-red-500/50")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="mb-0">{STEPS.findIndex((s) => s.key === current) + 1}. {st.title}</CardTitle>
              <Badge tone={STATE_LABEL[st.state][1]} data-testid="step-state">{STATE_LABEL[st.state][0]}</Badge>
            </div>
            <p className="text-sm">{st.note}</p>
            {st.fix && st.state !== "connected" && <p className="text-sm muted">Fix: {st.fix}</p>}
          </Card>
          <StepBody step={current} />
        </div>
      </div>
    </div>
  );
}

async function StepBody({ step }: { step: StepKey }) {
  const ctx = await requireAdmin();
  const org = ctx.org;
  const progress = progressOf(org);
  switch (step) {
    case "basics": {
      const medical = isMedicalIndustry(org.industry);
      return (
        <Card>
          <ActionForm action={saveBasicsAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Label>Business name<Input name="name" defaultValue={org.name} required /></Label>
              <Label>Website<Input name="website_url" defaultValue={org.website_url ?? ""} placeholder="https://…" /></Label>
              <Label>Time zone
                <Select name="timezone" defaultValue={org.timezone}>
                  {[...new Set([org.timezone, ...TIMEZONES])].map((z) => <option key={z} value={z}>{z.replace("_", " ")}</option>)}
                </Select>
              </Label>
              <Label>Industry
                <Select name="industry" defaultValue={org.industry}>
                  {[...new Set([org.industry, ...INDUSTRIES])].map((i) => <option key={i} value={i}>{i.replace(/_/g, " ")}</option>)}
                </Select>
              </Label>
              <Label hint="Printed in every email (required by law).">Street address<Input name="address" defaultValue={org.address ?? ""} placeholder="100 Main St, City, ST 00000" /></Label>
              <Label>Business phone<Input name="phone" type="tel" defaultValue={org.phone ?? ""} /></Label>
            </div>
            {medical && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm" data-testid="baa-blocker">
                <p className="font-medium">Healthcare: HIPAA business associate agreements required</p>
                <p className="mt-1">This account can't go live until BAAs are signed with every vendor that touches lead data:</p>
                <ul className="ml-5 list-disc">{BAA_VENDORS.map((v) => <li key={v}>{v}</li>)}</ul>
                <p className="mt-1 muted">{org.hipaa_baa_confirmed_at ? `Confirmed ${fmtTime(org.hipaa_baa_confirmed_at, org.timezone)}.` : "Not confirmed yet. The Leadline team confirms once all BAAs are on file."}</p>
                {ctx.isPlatformAdmin && (
                  <label className="mt-2 flex items-center gap-2">
                    <input type="hidden" name="baa_present" value="1" />
                    <input type="checkbox" name="hipaa_baa_confirmed" defaultChecked={!!org.hipaa_baa_confirmed_at} /> (Platform admin) All BAAs are signed and on file
                  </label>
                )}
              </div>
            )}
            <SubmitButton>Save basics</SubmitButton>
          </ActionForm>
        </Card>
      );
    }

    case "facebook": {
      const fb = (progress.facebook ?? {}) as { zap_created?: boolean; page_name?: string };
      return (
        <Card className="space-y-3">
          <p className="text-sm">Until the native Facebook connection is approved by Meta, leads arrive through Zapier:</p>
          <ol className="ml-5 list-decimal space-y-1 text-sm">
            <li>In Zapier, create a Zap with trigger <b>Facebook Lead Ads → New Lead</b> and pick your Page and form.</li>
            <li>Add the action <b>Webhooks by Zapier → POST</b>, payload type JSON, to the URL below.</li>
            <li>Map: lead id, form id, campaign name, ad name, full name, phone, email, ZIP, and every form question.</li>
            <li>Turn the Zap on and press <b>Test</b>. The lead shows up in your inbox (in dry run, nothing is texted).</li>
          </ol>
          <CopyField label="Your intake URL (keep it private)" value={`${env.appUrl}/api/intake/zapier/${org.intake_key}`} />
          <ActionForm action={saveFacebookAction} className="space-y-2">
            <Label>Facebook Page name<Input name="page_name" defaultValue={fb.page_name ?? ""} /></Label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="zap_created" defaultChecked={!!fb.zap_created} /> I've created and turned on the Zap</label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
      );
    }

    case "consent": {
      const sources = await withUserDb(ctx.user.id, (c) => q<LeadSource>(c, "select * from lead_sources where org_id = $1 order by created_at", [org.id]));
      return (
        <div className="space-y-3">
          <p className="text-sm">For each lead form, paste the SMS consent disclosure exactly as it appears on the form. Leads from a form without a verified disclosure that covers automated texts get <b>email only</b>; the app refuses automated texts for them.</p>
          {sources.map((s) => (
            <Card key={s.id}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="mb-0">{s.name}{s.meta_form_id ? <span className="ml-1 text-xs font-normal muted">form {s.meta_form_id}</span> : null}</CardTitle>
                {s.consent_verified_at && s.consent_text
                  ? <Badge tone={s.consent_covers_automated ? "green" : "yellow"}>{s.consent_covers_automated ? "Automated texts OK" : "Verified, email only"}</Badge>
                  : <Badge tone="red">No verified consent: email only</Badge>}
              </div>
              <ActionForm action={saveConsentAction} className="space-y-2">
                <input type="hidden" name="source_id" value={s.id} />
                <Label>Disclosure text<Textarea name="consent_text" defaultValue={s.consent_text ?? ""} className="min-h-24" placeholder="By submitting, you agree that [Business] may send you automated marketing text messages at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out." /></Label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="consent_covers_automated" defaultChecked={s.consent_covers_automated} /> The disclosure covers automated texts</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="verified" defaultChecked={!!s.consent_verified_at} /> I confirm this text appears on the form, next to the submit button</label>
                {s.consent_verified_at && <p className="text-xs muted">Verified {fmtTime(s.consent_verified_at, org.timezone)}. Each lead keeps a snapshot of the text in force when they submitted.</p>}
                <SubmitButton>Save consent</SubmitButton>
              </ActionForm>
            </Card>
          ))}
          <Card>
            <CardTitle>Add a lead form</CardTitle>
            <p className="mb-2 text-xs muted">Forms also appear here automatically when their first lead arrives through Zapier.</p>
            <ActionForm action={addSourceAction} className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <Label>Form name<Input name="name" required /></Label>
              <Label>Facebook form id<Input name="meta_form_id" placeholder="optional" /></Label>
              <SubmitButton>Add</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      );
    }

    case "phone": {
      const ph = (progress.phone ?? {}) as { registration?: Record<string, string | string[]>; submitted_at?: string };
      const r = ph.registration ?? {};
      const samples = (r.samples as string[] | undefined) ?? sampleMessages(org.name);
      const v = (k: string, d = "") => (typeof r[k] === "string" ? (r[k] as string) : d);
      return (
        <Card className="space-y-3">
          <p className="text-sm">US carriers require every business that texts to register its brand and use case. We buy a local number and file the registration with these details. <b>Texting turns on when the registration is approved</b> (usually days, sometimes weeks). Until then, leads are emailed.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
            <dt className="muted">Status</dt>
            <dd>{org.texting_enabled ? "Approved: texting on" : ph.submitted_at ? `Submitted ${fmtTime(ph.submitted_at, org.timezone)}, waiting for approval` : "Not submitted"}</dd>
            {org.sms_from_number && <><dt className="muted">Number</dt><dd>{fmtPhone(org.sms_from_number)}</dd></>}
          </dl>
          <ActionForm action={savePhoneRegistrationAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Label hint="Exactly as on your IRS records.">Legal business name<Input name="legal_name" defaultValue={v("legal_name", org.name)} /></Label>
              <Label>EIN<Input name="ein" defaultValue={v("ein")} placeholder="12-3456789" /></Label>
              <Label>Business type
                <Select name="business_type" defaultValue={v("business_type", "private_for_profit")}>
                  <option value="private_for_profit">Private company</option>
                  <option value="public_for_profit">Public company</option>
                  <option value="non_profit">Non-profit</option>
                  <option value="sole_proprietor">Sole proprietor</option>
                </Select>
              </Label>
              <Label>Website<Input name="website" defaultValue={v("website", org.website_url ?? "")} /></Label>
              <Label>Street<Input name="street" defaultValue={v("street", org.address?.split(",")[0] ?? "")} /></Label>
              <Label>City<Input name="city" defaultValue={v("city")} /></Label>
              <Label>State<Input name="state" defaultValue={v("state")} maxLength={2} placeholder="IL" /></Label>
              <Label>ZIP<Input name="zip" defaultValue={v("zip")} /></Label>
              <Label>Contact name<Input name="contact_name" defaultValue={v("contact_name")} /></Label>
              <Label>Contact email<Input name="contact_email" type="email" defaultValue={v("contact_email", ctx.user.email ?? "")} /></Label>
              <Label>Contact phone<Input name="contact_phone" type="tel" defaultValue={v("contact_phone")} /></Label>
              <Label hint="For your local number.">Preferred area code<Input name="area_code" defaultValue={v("area_code")} maxLength={3} /></Label>
            </div>
            <Label>How you'll text leads<Textarea name="use_case" defaultValue={v("use_case", `${org.name} replies to customers who request information through our lead forms, answers their questions, and schedules appointments. Messages are conversational and sent only to people who submitted a form with SMS consent.`)} /></Label>
            <Label>How leads opt in<Textarea name="opt_in" defaultValue={v("opt_in", "Customers submit a Facebook lead form or website form that includes an SMS consent disclosure next to the submit button. The disclosure names the business, says messages may be automated, that consent is not a condition of purchase, and how to opt out.")} /></Label>
            {[0, 1, 2].map((i) => (
              <Label key={i}>Sample message {i + 1}<Textarea name={`sample_${i + 1}`} defaultValue={samples[i] ?? ""} className="min-h-16" /></Label>
            ))}
            <div className="flex flex-wrap gap-2">
              <SubmitButton name="intent" value="submit">Submit registration details</SubmitButton>
              <SubmitButton name="intent" value="draft" variant="secondary">Save draft</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      );
    }

    case "email": {
      const em = (progress.email ?? {}) as { custom_domain_requested?: string };
      return (
        <Card className="space-y-3">
          <p className="text-sm">By default the assistant emails from the app's domain under your business name. Replies come straight back into the lead's thread.</p>
          <CopyField label="Sends as" value={`${org.name} <${org.slug}@${env.postmarkSendingDomain}>`} />
          <ActionForm action={saveEmailStepAction} className="space-y-2">
            <Label hint="Optional. We'll show the DNS records (DKIM and Return-Path) to add.">Custom sending domain<Input name="custom_domain" defaultValue={em.custom_domain_requested ?? ""} placeholder="mail.yourbusiness.com" /></Label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
      );
    }

    case "hours": {
      const row = await withUserDb(ctx.user.id, (c) => maybeOne<Availability>(c, "select * from availability where org_id = $1 and user_id is null", [org.id]));
      return (
        <div className="space-y-3">
          <Card>
            <CardTitle>Bookable hours</CardTitle>
            <AvailabilityForm row={row} userId={null} />
          </Card>
          <Card className="space-y-2">
            <CardTitle>Calendars</CardTitle>
            <p className="text-sm">Each rep can connect Google Calendar so busy times aren't offered and bookings land on their calendar.</p>
            <ButtonLink href="/api/integrations/google/start" variant="secondary" prefetch={false}>Connect my Google Calendar</ButtonLink>
            <p className="text-xs muted">Per-rep hours and calendar status: <Link className="underline" href="/settings/hours">Hours</Link> · <Link className="underline" href="/settings/integrations">Integrations</Link></p>
          </Card>
        </div>
      );
    }

    case "team": {
      const members = await withUserDb(ctx.user.id, (c) => q<Membership>(c, "select * from memberships where org_id = $1 and active order by role, display_name", [org.id]));
      return (
        <div className="space-y-3">
          <Card>
            <CardTitle>Team</CardTitle>
            <ul className="space-y-1 text-sm">
              {members.map((m) => (
                <li key={m.id} className="flex flex-wrap justify-between gap-2">
                  <span>{m.display_name} <span className="text-xs muted">{m.role}</span></span>
                  <span className={m.mobile_phone ? "muted" : "text-amber-700 dark:text-amber-300"}>{m.mobile_phone ? fmtPhone(m.mobile_phone) : "no mobile for alerts"}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs muted">Assignment: {org.assignment_mode === "round_robin" ? "round robin" : "single owner"}. Change routing, mobile numbers and the backup handler in <Link href="/settings/team" className="underline">Team settings</Link>.</p>
          </Card>
          <Card>
            <CardTitle>Invite a rep</CardTitle>
            <InviteForm canOwner={ctx.role === "owner" || ctx.isPlatformAdmin} />
          </Card>
        </div>
      );
    }

    case "playbook": {
      const pb = await withUserDb(ctx.user.id, (c) => maybeOne<Playbook>(c, "select * from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1", [org.id]));
      return (
        <div className="space-y-3">
          {pb && (
            <Card className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                Current playbook: <b>{pb.name}</b> v{pb.version} {pb.approved_at ? <Badge tone="green">approved</Badge> : <Badge tone="yellow">needs approval</Badge>}
              </div>
              <div className="flex gap-2">
                <ButtonLink href="/settings/playbook" variant="secondary">Edit and test</ButtonLink>
                {!pb.approved_at && (
                  <form action={approvePlaybookAction}>
                    <input type="hidden" name="playbook_id" value={pb.id} />
                    <SubmitButton>Approve</SubmitButton>
                  </form>
                )}
              </div>
            </Card>
          )}
          <Card className="space-y-2">
            <CardTitle>{pb ? "Draft a new version from your website" : "Draft your playbook from your website"}</CardTitle>
            <p className="text-sm muted">We read up to 10 pages (home, about, services, specials, FAQ, contact, hours…), pull out the facts, and draft the playbook and knowledge base. Nothing is used until you save it, and going live needs your approval.</p>
            <DraftWizard
              websiteUrl={org.website_url}
              defaults={{ no_reply: DEFAULT_NO_REPLY, went_quiet: DEFAULT_WENT_QUIET }}
              orgSendSundays={org.send_sundays}
              generate={generateDraftAction}
              save={saveDraftAction}
            />
          </Card>
        </div>
      );
    }

    case "crm": {
      const adf = await withUserDb(ctx.user.id, (c) => maybeOne<{ config: { address?: string } }>(c, "select config from integrations where org_id = $1 and kind = 'adf_email' and user_id is null", [org.id]));
      return (
        <Card className="space-y-3">
          <p className="text-sm">Optional. Send qualified leads and booked appointments to your CRM. Nearly every dealer CRM accepts ADF/XML by email.</p>
          <ActionForm action={saveAdfAction} className="space-y-2">
            <Label>CRM lead email (ADF/XML)<Input name="address" type="email" defaultValue={adf?.config.address ?? ""} placeholder="leads@yourcrm.com" /></Label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
          <p className="text-xs muted">Prefer a signed webhook, or want the Conversions API? Set them up in <Link className="underline" href="/settings/integrations">Integrations</Link>.</p>
        </Card>
      );
    }

    case "golive": {
      const status = await goLiveStatus(service(), org.id);
      const medicalBlocker = status.blockers.find((b) => b.code === "hipaa_baa_missing");
      return (
        <div className="space-y-3">
          <Card className="space-y-2">
            <CardTitle>1. Test</CardTitle>
            <p className="text-sm">Text yourself as a fake lead in the simulator and check the replies, the booking and the handoff.</p>
            <ButtonLink href="/simulator" variant="secondary">Open the simulator</ButtonLink>
          </Card>
          <Card className="space-y-2">
            <CardTitle>2. Go live</CardTitle>
            {status.blockers.length > 0 ? (
              <ul className="space-y-2" data-testid="blockers">
                {status.blockers.map((b) => (
                  <li key={b.code} className="rounded-lg border border-red-500/40 bg-red-500/5 p-2 text-sm">
                    <p className="font-medium">{b.message}</p>
                    {b === medicalBlocker && <ul className="ml-5 list-disc">{BAA_VENDORS.map((v) => <li key={v}>{v}</li>)}</ul>}
                    <p className="muted">Fix: {b.fix} <Link href={`/onboarding?step=${b.step}`} className="underline">Go to step</Link></p>
                  </li>
                ))}
              </ul>
            ) : org.status === "live" ? <p className="text-sm">You're live.</p> : <p className="text-sm">Everything required is in place.</p>}
            <p className={cx("text-sm", status.textingEnabled ? "" : "text-amber-700 dark:text-amber-300")} data-testid="texting-status">
              {status.textingEnabled ? "Texting is on." : "Texting is still off (carrier registration not approved yet). You can go live now; the assistant will email leads until texting turns on."}
            </p>
            {env.dryRun && <p className="text-xs muted">The platform is in dry-run mode: even when live, nothing reaches real people until the Leadline team turns dry-run off.</p>}
            {org.status !== "live" && (
              <ActionForm action={goLiveAction}>
                <SubmitButton>Go live</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>
      );
    }
  }
}
