// Native Meta lead intake (phase 3): connect with Facebook Login for Business, pick the Page forms to
// watch, subscribe to lead webhooks, backfill 7 days. Until Meta app review clears, use the Zapier bridge.
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { maybeOne, service } from "@/lib/db";
import { listForms } from "@/lib/integrations/meta-connect";
import { Badge, Button, ButtonLink, Card, CardTitle, PageHeader, Select } from "../../../_components/ui";
import { saveMetaFormsAction } from "../../../_actions/meta";

export const dynamic = "force-dynamic";

export default async function ConnectMeta({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireAdmin();
  const { error } = await searchParams;
  const integ = await maybeOne<{ status: string; last_error: string | null; config: { pages?: Array<{ id: string; name: string }>; ad_accounts?: Array<{ id: string; name: string }>; ad_account_id?: string } }>(
    service(), "select status, last_error, config from integrations where org_id = $1 and kind = 'meta'", [ctx.org.id]);
  let forms: Awaited<ReturnType<typeof listForms>> = [];
  let formsError: string | null = null;
  if (integ?.config.pages?.length) {
    try { forms = await listForms(service(), ctx.org.id); } catch (e) { formsError = (e as Error).message; }
  }
  const configured = !!(env.metaAppId && env.metaLoginConfigId);
  return (
    <div className="space-y-4">
      <PageHeader title="Facebook lead forms">Connect your Facebook Page so new leads arrive instantly by webhook.</PageHeader>
      {error && <Card className="text-sm text-red-600">{error}</Card>}
      <Card>
        <CardTitle>Connection {integ && <Badge tone={integ.status === "connected" ? "green" : integ.status === "error" ? "red" : "yellow"}>{integ.status}</Badge>}</CardTitle>
        {!configured && <p className="text-sm muted">The platform's Meta app isn't approved yet. Leads come in through the Zapier bridge until then: <code className="break-all">{env.appUrl}/api/intake/zapier/{ctx.org.intake_key}</code></p>}
        {configured && <ButtonLink href="/api/integrations/meta/start" prefetch={false}>{integ ? "Reconnect Facebook" : "Log in with Facebook"}</ButtonLink>}
        {integ?.last_error && <pre className="mt-3 whitespace-pre-wrap text-xs text-red-600">{integ.last_error}</pre>}
      </Card>
      {integ?.config.pages?.length ? (
        <Card>
          <CardTitle>Forms to watch</CardTitle>
          {formsError && <p className="text-sm text-red-600">{formsError}</p>}
          <form action={saveMetaFormsAction} className="space-y-3">
            <ul className="space-y-1 text-sm">
              {forms.map((f) => (
                <li key={f.formId}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="form" value={JSON.stringify({ id: f.formId, page_id: f.pageId, name: f.formName })} defaultChecked={f.selected} />
                    <span>{f.formName}</span> <span className="muted">· {f.pageName} · {f.status}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!!integ.config.ad_accounts?.length && (
              <label className="block text-sm">Ad account for cost per appointment
                <Select name="ad_account_id" defaultValue={integ.config.ad_account_id ?? ""}>
                  <option value="">—</option>
                  {integ.config.ad_accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
                </Select>
              </label>
            )}
            <p className="text-xs muted">Remember: each form needs its SMS consent disclosure recorded in Setup → Consent before the agent will text its leads.</p>
            <Button>Save and backfill 7 days</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
