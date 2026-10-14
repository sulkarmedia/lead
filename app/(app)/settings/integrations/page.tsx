// /settings/integrations: a status card per integration (connected / pending / not connected / error
// with the last error) and its edit or reconnect form.
import { requireAdmin } from "@/lib/auth";
import { maybeOne, q, withUserDb } from "@/lib/db";
import type { Membership } from "@/lib/db/types";
import { env } from "@/lib/env";
import { fmtPhone, fmtTime } from "@/lib/format";
import { ButtonLink, Card, Input, Label, PageHeader } from "../../../_components/ui";
import { saveAdfAction, saveCapiAction, savePhoneAction, saveWebhookAction } from "../../../_actions/settings";
import { ActionForm, SubmitButton } from "../_components/ActionForm";
import { CopyField, IntegrationCard, StatusBadge, type IntegrationRow } from "./_components/IntegrationCard";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettings() {
  const ctx = await requireAdmin();
  const org = ctx.org;
  const { rows, members, lastZapierLead } = await withUserDb(ctx.user.id, async (c) => ({
    rows: await q<IntegrationRow>(c, "select id, kind::text, user_id, status::text, config, (secret_enc is not null) as has_secret, last_error, updated_at from integrations where org_id = $1", [org.id]),
    members: await q<Membership>(c, "select * from memberships where org_id = $1 and active order by display_name", [org.id]),
    lastZapierLead: await maybeOne<{ created_at: Date }>(c,
      "select l.created_at from leads l join lead_sources s on s.id = l.source_id where l.org_id = $1 and s.kind = 'zapier' order by l.created_at desc limit 1", [org.id]),
  }));
  const row = (kind: string, userId: string | null = null) => rows.find((r) => r.kind === kind && r.user_id === userId) ?? null;
  const meta = row("meta");
  const zapier = row("zapier");
  const intakeUrl = `${env.appUrl}/api/intake/zapier/${org.intake_key}`;
  const reg = (org.onboarding_progress?.phone ?? {}) as { submitted_at?: string };
  const phoneStatus = org.texting_enabled ? "connected" : reg.submitted_at || org.sms_from_number ? "pending" : "not_connected";
  const pmDomain = row("postmark_domain");
  const adf = row("adf_email");
  const hook = row("crm_webhook");
  const capi = row("capi");
  const tz = org.timezone;

  return (
    <div className="space-y-4">
      <PageHeader title="Integrations">Where leads come from, how the assistant reaches them, and where results go.</PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">

        <IntegrationCard title="Facebook lead ads" status={meta?.status === "connected" ? "connected" : zapier?.status === "connected" || lastZapierLead ? "connected" : "not_connected"} row={meta ?? zapier}>
          <p className="text-sm">Phase 1 uses the Zapier bridge: a Zap from <b>Facebook Lead Ads → Webhooks by Zapier (POST)</b> to this URL. Native Facebook connection arrives after Meta's app review.</p>
          <CopyField label="Zapier intake URL" value={intakeUrl} />
          <p className="text-xs muted">Send JSON with the lead id, form id, campaign and ad names, name, phone, email and every form answer. Keep this URL private; it accepts leads for your account.</p>
          <p className="text-xs muted">Last lead via Zapier: {lastZapierLead ? fmtTime(lastZapierLead.created_at, tz) : "none yet"}</p>
        </IntegrationCard>

        <IntegrationCard title="Phone number (texting)" status={phoneStatus} row={row("twilio")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="muted">Number</dt><dd>{org.sms_from_number ? fmtPhone(org.sms_from_number) : "not assigned"}</dd>
            <dt className="muted">Messaging service</dt><dd className="break-all">{org.twilio_messaging_service_sid ?? "—"}</dd>
            <dt className="muted">Texting</dt><dd>{org.texting_enabled ? "on (carrier registration approved)" : "off until carrier registration is approved"}</dd>
          </dl>
          {!org.texting_enabled && <p className="text-xs muted">Registration details are collected in the <a href="/onboarding?step=phone" className="underline">setup wizard</a>. Until approval, leads are emailed only.</p>}
          {ctx.isPlatformAdmin ? (
            <ActionForm action={savePhoneAction} className="space-y-2 border-t border-app pt-3">
              <p className="text-xs font-medium">Platform admin</p>
              <Label>Number (E.164)<Input name="sms_from_number" defaultValue={org.sms_from_number ?? ""} placeholder="+16305550100" /></Label>
              <Label>Messaging Service SID<Input name="twilio_messaging_service_sid" defaultValue={org.twilio_messaging_service_sid ?? ""} placeholder="MG…" /></Label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="texting_enabled" defaultChecked={org.texting_enabled} /> Carrier registration approved: texting on</label>
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-xs muted">The number and the texting switch are managed by the Leadline team because they depend on carrier approval.</p>
          )}
        </IntegrationCard>

        <IntegrationCard title="Email" status={pmDomain?.status === "error" ? "error" : pmDomain?.status === "pending" ? "pending" : env.postmarkServerToken || env.dryRun ? "connected" : "not_connected"} row={pmDomain}>
          <CopyField label="Sends as" value={`${org.name} <${org.slug}@${env.postmarkSendingDomain}>`} />
          <p className="text-xs muted">Replies come back to the lead's thread through a per-lead address at {env.postmarkInboundDomain}. Every email carries an unsubscribe link and your address{org.address ? ` (${org.address})` : " (missing: add it in the setup wizard)"}.</p>
          {pmDomain && <p className="text-xs muted">Custom domain: {String(pmDomain.config.domain ?? "")} ({pmDomain.status})</p>}
        </IntegrationCard>

        <IntegrationCard title="Google Calendar (per rep)" status={members.some((m) => row("google_calendar", m.user_id)?.status === "connected") ? "connected" : "not_connected"}>
          <ul className="space-y-1 text-sm">
            {members.map((m) => {
              const g = row("google_calendar", m.user_id);
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{m.display_name}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={g?.status ?? "not_connected"} />
                    {m.user_id === ctx.user.id && (
                      <ButtonLink href="/api/integrations/google/start" variant="secondary" className="px-2 py-1 text-xs" prefetch={false}>{g ? "Reconnect" : "Connect mine"}</ButtonLink>
                    )}
                  </span>
                  {g?.last_error && <span className="w-full text-xs text-red-600">{g.last_error}</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-xs muted">Each rep connects their own calendar after signing in. Busy times are removed from offered slots; bookings land on the calendar.</p>
        </IntegrationCard>

        <IntegrationCard title="CRM push: ADF/XML email" status={adf?.status ?? "not_connected"} row={adf}>
          <ActionForm action={saveAdfAction} className="space-y-2">
            <Label hint="Your CRM's lead-import address. Sent when a lead is qualified or books. Leave empty to turn off.">CRM lead email
              <Input name="address" type="email" defaultValue={String(adf?.config.address ?? "")} placeholder="leads@yourcrm.com" />
            </Label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </IntegrationCard>

        <IntegrationCard title="CRM push: outbound webhook" status={hook?.status ?? "not_connected"} row={hook}>
          <ActionForm action={saveWebhookAction} className="space-y-2">
            <Label hint="Signed JSON (X-Leadline-Signature, HMAC-SHA256) for lead.created, lead.qualified, appointment.set, appointment.showed, lead.opted_out. Leave empty to turn off.">Webhook URL
              <Input name="url" type="url" defaultValue={String(hook?.config.url ?? "")} placeholder="https://…" />
            </Label>
            {hook?.has_secret && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="regenerate" /> Generate a new signing secret</label>}
            <p className="text-xs muted">{hook?.has_secret ? "A signing secret is set (hidden)." : "A signing secret is generated on save and shown once."}</p>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </IntegrationCard>

        <IntegrationCard title="Meta Conversions API" status={capi?.status ?? "not_connected"} row={capi}>
          <ActionForm action={saveCapiAction} className="space-y-2">
            <p className="text-xs muted">Sends qualified, appointment set, showed and sold back to Meta so campaigns optimize for real outcomes.</p>
            <Label hint="Events Manager → your dataset (pixel) → Settings. Leave empty to turn off.">Dataset ID
              <Input name="dataset_id" inputMode="numeric" defaultValue={String(capi?.config.dataset_id ?? org.capi_dataset_id ?? "")} />
            </Label>
            <Label hint={capi?.has_secret ? "Saved (hidden). Paste a new one to replace it." : "Generated in Events Manager → Settings → Conversions API."}>Access token
              <Input name="access_token" type="password" autoComplete="off" />
            </Label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </IntegrationCard>
      </div>
    </div>
  );
}
