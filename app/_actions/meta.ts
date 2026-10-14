"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, audit } from "@/lib/auth";
import { q, service } from "@/lib/db";
import { selectForms } from "@/lib/integrations/meta-connect";
import { backfillMeta } from "@/lib/integrations/meta-sync";

export async function saveMetaFormsAction(form: FormData) {
  const ctx = await requireAdmin();
  const forms = form.getAll("form").map((v) => JSON.parse(String(v)) as { id: string; page_id: string; name: string });
  const problems = await selectForms(service(), ctx.org.id, forms);
  const adAccount = String(form.get("ad_account_id") ?? "");
  if (adAccount) await q(service(), "update integrations set config = config || jsonb_build_object('ad_account_id', $2::text) where org_id = $1 and kind = 'meta'", [ctx.org.id, adAccount]);
  await audit(ctx, "select_forms", "integration:meta", null, { forms: forms.map((f) => f.id), problems });
  if (problems.length === 0) await backfillMeta(service(), ctx.org.id).catch(() => 0);
  revalidatePath("/connect/meta");
}
