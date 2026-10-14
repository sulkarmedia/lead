// Meta lead ads: webhook verification, signature check, lead retrieval by leadgen_id.
// Docs: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving and
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started
import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../env";
import { safeEqual } from "../crypto";

export function verifyMetaSignature(rawBody: string, header: string | null, appSecret = env.metaAppSecret): boolean {
  if (!header || !appSecret) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, header);
}

export const LeadgenWebhook = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            leadgen_id: z.union([z.string(), z.number()]).transform(String),
            page_id: z.union([z.string(), z.number()]).transform(String),
            form_id: z.union([z.string(), z.number()]).transform(String).optional(),
            ad_id: z.union([z.string(), z.number()]).transform(String).optional(),
            adgroup_id: z.union([z.string(), z.number()]).transform(String).optional(),
            created_time: z.number().optional(),
          }).passthrough(),
        }),
      ),
    }),
  ),
});

const MetaLead = z.object({
  id: z.string(),
  created_time: z.string().optional(),
  form_id: z.string().optional(),
  ad_id: z.string().optional(), ad_name: z.string().optional(),
  adset_id: z.string().optional(), adset_name: z.string().optional(),
  campaign_id: z.string().optional(), campaign_name: z.string().optional(),
  field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
}).passthrough();
export type MetaLead = z.infer<typeof MetaLead>;

export const LEAD_FIELDS = "id,created_time,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,field_data";

const graph = (path: string) => `https://graph.facebook.com/${env.metaGraphVersion}/${path}`;

export async function graphGet<T = unknown>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const u = new URL(graph(path));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(`graph ${res.status}: ${json?.error?.message ?? ""}`), { code: json?.error?.code, subcode: json?.error?.error_subcode });
  return json as T;
}

export async function fetchLead(leadgenId: string, pageToken: string): Promise<MetaLead> {
  return MetaLead.parse(await graphGet(leadgenId, pageToken, { fields: LEAD_FIELDS }));
}

export async function listFormLeads(formId: string, pageToken: string, sinceUnix: number): Promise<MetaLead[]> {
  const out: MetaLead[] = [];
  let next: string | null = null;
  let page = await graphGet<{ data: unknown[]; paging?: { next?: string } }>(`${formId}/leads`, pageToken, {
    fields: LEAD_FIELDS, limit: "100", filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnix }]),
  });
  for (let i = 0; i < 20; i++) {
    out.push(...page.data.map((d) => MetaLead.parse(d)));
    next = page.paging?.next ?? null;
    if (!next) break;
    const res = await fetch(next, { signal: AbortSignal.timeout(15_000) });
    page = await res.json();
  }
  return out;
}

const STANDARD: Record<string, string> = {
  full_name: "full_name", first_name: "first_name", last_name: "last_name", email: "email",
  phone_number: "phone", phone: "phone", zip_code: "zip", post_code: "zip", zip: "zip",
};

/** Convert a Graph API lead into the intake shape. Non-standard questions become answers. */
export function metaLeadToIntake(l: MetaLead) {
  const out: Record<string, unknown> = {
    meta_lead_id: l.id, form_id: l.form_id, created_time: l.created_time,
    ad_id: l.ad_id, ad_name: l.ad_name, adset_id: l.adset_id, adset_name: l.adset_name, campaign_id: l.campaign_id, campaign_name: l.campaign_name,
  };
  const answers: Record<string, unknown> = {};
  for (const f of l.field_data) {
    const v = f.values.length > 1 ? f.values : f.values[0];
    const std = STANDARD[f.name];
    if (std) out[std] = v;
    else answers[f.name] = v;
  }
  out.answers = answers;
  return out;
}
