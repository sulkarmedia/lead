// Native Meta intake (phase 3): page tokens per tenant, webhook events → lead fetch → intake,
// 7-day backfill on connect, and a 15-minute poll per watched form as a safety net.
import type { Db } from "../db";
import { maybeOne, q } from "../db";
import { decrypt } from "../crypto";
import { now } from "../clock";
import { log } from "../log";
import { ensureSource, ingestLead } from "../leads/intake";
import { fetchLead, listFormLeads, metaLeadToIntake } from "./meta";

interface MetaConfig { pages?: Array<{ id: string; name: string; token_enc: string }>; forms?: Array<{ id: string; page_id: string; name: string }>; last_poll_at?: string }

async function metaConfig(db: Db, orgId: string): Promise<MetaConfig | null> {
  const row = await maybeOne<{ config: MetaConfig }>(db, "select config from integrations where org_id = $1 and kind = 'meta' and status = 'connected'", [orgId]);
  return row?.config ?? null;
}

/** Which org watches this page/form? */
export async function orgForPage(db: Db, pageId: string, formId?: string): Promise<{ orgId: string; token: string } | null> {
  const rows = await q<{ org_id: string; config: MetaConfig }>(db, "select org_id, config from integrations where kind = 'meta' and status = 'connected' and config->'pages' @> $1::jsonb", [JSON.stringify([{ id: pageId }])]);
  for (const r of rows) {
    if (formId && r.config.forms?.length && !r.config.forms.some((f) => f.id === formId)) continue;
    const page = r.config.pages!.find((p) => p.id === pageId)!;
    return { orgId: r.org_id, token: decrypt(page.token_enc) };
  }
  return null;
}

export async function ingestMetaLead(db: Db, leadgenId: string, pageId: string, formId?: string) {
  const target = await orgForPage(db, pageId, formId);
  if (!target) {
    log.warn("meta.unmatched_page", { page_id: pageId, form_id: formId });
    return null;
  }
  const dup = await maybeOne(db, "select 1 from leads where org_id = $1 and meta_lead_id = $2", [target.orgId, leadgenId]);
  if (dup) return { status: "duplicate" };
  const lead = await fetchLead(leadgenId, target.token);
  const source = await ensureSource(db, target.orgId, "meta_form", lead.form_id ?? formId ?? null);
  return ingestLead(target.orgId, source.id, metaLeadToIntake(lead), "meta_webhook");
}

export async function pollMetaForms(db: Db, orgId: string, sinceOverride?: Date) {
  const cfg = await metaConfig(db, orgId);
  if (!cfg?.forms?.length) return 0;
  const since = sinceOverride ?? new Date(now().getTime() - 2 * 3600_000); // overlap generously; intake dedupes
  let n = 0;
  for (const form of cfg.forms) {
    const page = cfg.pages?.find((p) => p.id === form.page_id);
    if (!page) continue;
    try {
      const leads = await listFormLeads(form.id, decrypt(page.token_enc), Math.floor(since.getTime() / 1000));
      const source = await ensureSource(db, orgId, "meta_form", form.id, form.name);
      for (const l of leads) {
        const r = await ingestLead(orgId, source.id, metaLeadToIntake(l), "meta_poll");
        if (r.status === "created") n++;
      }
    } catch (e) {
      await q(db, "update integrations set last_error = $2, updated_at = now() where org_id = $1 and kind = 'meta'", [orgId, (e as Error).message]);
      log.error("meta.poll_failed", { org_id: orgId, form_id: form.id, error: (e as Error).message });
    }
  }
  return n;
}

/** On connect: backfill the last 7 days. */
export async function backfillMeta(db: Db, orgId: string) {
  return pollMetaForms(db, orgId, new Date(now().getTime() - 7 * 86400_000));
}
