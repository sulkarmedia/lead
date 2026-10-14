// Facebook Login for Business (configuration id) → long-lived user token → Page tokens → pick forms →
// subscribe the app to each Page's `leadgen` field → backfill 7 days. Ad spend for cost per appointment.
// Docs: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business,
// https://developers.facebook.com/docs/marketing-api/guides/lead-ads/quickstart/webhooks-integration
import type { Db } from "../db";
import { maybeOne, q } from "../db";
import { decrypt, encrypt } from "../crypto";
import { env } from "../env";
import { now } from "../clock";
import { graphGet } from "./meta";

const graph = (path: string) => `https://graph.facebook.com/${env.metaGraphVersion}/${path}`;

export function metaLoginUrl(state: string) {
  const p = new URLSearchParams({
    client_id: env.metaAppId ?? "",
    redirect_uri: `${env.appUrl}/api/integrations/meta/callback`,
    config_id: env.metaLoginConfigId ?? "",
    response_type: "code",
    override_default_response_type: "true",
    state,
  });
  return `https://www.facebook.com/${env.metaGraphVersion}/dialog/oauth?${p}`;
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = await res.json();
  if (!res.ok) throw new Error(`meta ${res.status}: ${json?.error?.message ?? ""}`);
  return json;
}

export async function exchangeMetaCode(db: Db, orgId: string, code: string) {
  const short = await getJson(graph(`oauth/access_token?${new URLSearchParams({ client_id: env.metaAppId!, client_secret: env.metaAppSecret!, redirect_uri: `${env.appUrl}/api/integrations/meta/callback`, code })}`));
  const long = await getJson(graph(`oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: env.metaAppId!, client_secret: env.metaAppSecret!, fb_exchange_token: short.access_token })}`));
  const pages = await graphGet<{ data: Array<{ id: string; name: string; access_token: string; tasks?: string[] }> }>("me/accounts", long.access_token, { fields: "id,name,access_token,tasks", limit: "100" });
  const adAccounts = await graphGet<{ data: Array<{ id: string; name: string }> }>("me/adaccounts", long.access_token, { fields: "id,name", limit: "100" }).catch(() => ({ data: [] }));
  const config = {
    pages: pages.data.map((p) => ({ id: p.id, name: p.name, token_enc: encrypt(p.access_token) })),
    forms: [],
    ad_accounts: adAccounts.data,
    connected_at: now().toISOString(),
  };
  await q(
    db,
    `insert into integrations (org_id, kind, status, config, secret_enc, last_error, updated_at) values ($1, 'meta', 'pending', $2, $3, null, now())
     on conflict (org_id, kind, coalesce(user_id, '00000000-0000-0000-0000-000000000000'))
     do update set status = 'pending', config = excluded.config, secret_enc = excluded.secret_enc, last_error = null, updated_at = now()`,
    [orgId, JSON.stringify(config), encrypt(long.access_token)],
  );
  return config.pages.length;
}

export async function listForms(db: Db, orgId: string) {
  const row = await maybeOne<{ config: { pages: Array<{ id: string; name: string; token_enc: string }>; forms?: Array<{ id: string }> } }>(
    db, "select config from integrations where org_id = $1 and kind = 'meta'", [orgId]);
  if (!row) return [];
  const out: Array<{ pageId: string; pageName: string; formId: string; formName: string; status: string; selected: boolean }> = [];
  for (const p of row.config.pages) {
    const forms = await graphGet<{ data: Array<{ id: string; name: string; status: string }> }>(`${p.id}/leadgen_forms`, decrypt(p.token_enc), { fields: "id,name,status", limit: "100" });
    for (const f of forms.data) out.push({ pageId: p.id, pageName: p.name, formId: f.id, formName: f.name, status: f.status, selected: !!row.config.forms?.some((x) => x.id === f.id) });
  }
  return out;
}

/**
 * Save the watched forms, subscribe the app to each page's leadgen field, and check that the app
 * can actually read leads (the Page's Leads Access Manager can deny CRM access).
 */
export async function selectForms(db: Db, orgId: string, forms: Array<{ id: string; page_id: string; name: string }>) {
  const row = await maybeOne<{ config: { pages: Array<{ id: string; name: string; token_enc: string }> } }>(db, "select config from integrations where org_id = $1 and kind = 'meta'", [orgId]);
  if (!row) throw new Error("Meta is not connected");
  const problems: string[] = [];
  for (const pageId of new Set(forms.map((f) => f.page_id))) {
    const page = row.config.pages.find((p) => p.id === pageId);
    if (!page) continue;
    const token = decrypt(page.token_enc);
    const res = await fetch(graph(`${pageId}/subscribed_apps`), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ subscribed_fields: "leadgen", access_token: token }),
    });
    if (!res.ok) problems.push(`${page.name}: could not subscribe to lead webhooks (${(await res.json().catch(() => ({})))?.error?.message ?? res.status})`);
    for (const f of forms.filter((x) => x.page_id === pageId)) {
      try {
        await graphGet(`${f.id}/leads`, token, { limit: "1" });
      } catch (e) {
        problems.push(`${f.name}: can't read leads — in Meta Business Suite open Settings → Leads Access, and give ${env.appName} (CRM) access to this Page. (${(e as Error).message})`);
      }
      await q(db, `insert into lead_sources (org_id, kind, name, meta_page_id, meta_form_id, playbook_id)
                   values ($1, 'meta_form', $2, $3, $4, (select id from playbooks where org_id = $1 order by approved_at desc nulls last, created_at limit 1))
                   on conflict (org_id, meta_form_id) where meta_form_id is not null do update set kind = 'meta_form', meta_page_id = excluded.meta_page_id, name = excluded.name`,
        [orgId, f.name, pageId, f.id]);
    }
  }
  await q(db, `update integrations set config = config || jsonb_build_object('forms', $2::jsonb), status = $3, last_error = $4, updated_at = now() where org_id = $1 and kind = 'meta'`,
    [orgId, JSON.stringify(forms), problems.length ? "error" : "connected", problems.length ? problems.join("\n") : null]);
  return problems;
}

/** Daily spend per campaign from the Marketing API insights edge. */
export async function pullAdSpend(db: Db, orgId: string, days = 7) {
  const row = await maybeOne<{ secret_enc: string | null; config: { ad_account_id?: string; ad_accounts?: Array<{ id: string }> } }>(db, "select secret_enc, config from integrations where org_id = $1 and kind = 'meta' and status in ('connected', 'error')", [orgId]);
  const account = row?.config.ad_account_id ?? row?.config.ad_accounts?.[0]?.id;
  if (!row?.secret_enc || !account) return 0;
  const until = now();
  const since = new Date(until.getTime() - days * 86400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const res = await graphGet<{ data: Array<{ campaign_id: string; campaign_name: string; spend: string; date_start: string }> }>(`${account}/insights`, decrypt(row.secret_enc), {
    level: "campaign", fields: "campaign_id,campaign_name,spend", time_increment: "1", time_range: JSON.stringify({ since: ymd(since), until: ymd(until) }), limit: "500",
  });
  for (const r of res.data) {
    await q(db, `insert into ad_spend_daily (org_id, day, campaign_id, campaign_name, spend) values ($1, $2, $3, $4, $5)
                 on conflict (org_id, day, campaign_id) do update set spend = excluded.spend, campaign_name = excluded.campaign_name`,
      [orgId, r.date_start, r.campaign_id, r.campaign_name, Number(r.spend)]);
  }
  return res.data.length;
}
