"use server";
// Platform-owner actions: managed onboarding (create org + owner), carrier-approval texting switch,
// HIPAA BAA confirmation. Every change is written to the target org's audit_log as platform_admin.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getOrgContext, audit, type OrgContext } from "@/lib/auth";
import { maybeOne, one, q, service, tx } from "@/lib/db";
import type { Org } from "@/lib/db/types";
import { env } from "@/lib/env";
import { now } from "@/lib/clock";
import { ensureUser } from "@/lib/seed";
import { log } from "@/lib/log";
import { isMedicalIndustry } from "@/lib/compliance";
import { BAA_VENDORS } from "../(app)/admin/_components/baa";

async function requirePlatformAdmin(): Promise<OrgContext> {
  const ctx = await getOrgContext();
  if (!ctx.isPlatformAdmin) redirect("/inbox");
  return ctx;
}

/** Audit against the target org, always attributed to the platform admin. */
async function auditOrg(ctx: OrgContext, org: Pick<Org, "id">, action: string, diff?: unknown) {
  await audit({ user: ctx.user, isPlatformAdmin: true, membership: null, org: org as Org }, action, "organization", org.id, diff);
}

const done = (orgId?: string) => {
  revalidatePath("/admin");
  if (orgId) revalidatePath(`/admin/orgs/${orgId}`);
};

const CreateOrg = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "slug: lowercase letters, digits and dashes"),
  industry: z.string().trim().min(2).max(60),
  timezone: z.string().trim().refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, "unknown time zone"),
  owner_email: z.string().trim().toLowerCase().email(),
  owner_name: z.string().trim().max(120).optional(),
});

/** Find the owner's auth user, or create one: Supabase Auth invite in production, the local shim in dev. */
async function ownerUserId(email: string): Promise<{ id: string; invited: boolean }> {
  const existing = await maybeOne<{ id: string }>(service(), "select id from auth.users where email = $1", [email]);
  if (existing) return { id: existing.id, invited: false };
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = env.supabaseUrl;
  if (!env.devLogin && url && key) {
    const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/invite`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, redirect_to: `${env.appUrl}/auth/callback` }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; user?: { id?: string }; msg?: string; message?: string };
    const id = body.id ?? body.user?.id;
    if (!res.ok || !id) throw new Error(`Supabase invite failed (${res.status}): ${body.msg ?? body.message ?? "no user id returned"}`);
    return { id, invited: true };
  }
  return { id: await ensureUser(service(), email), invited: false };
}

export async function createOrgAction(form: FormData) {
  const ctx = await requirePlatformAdmin();
  const input = CreateOrg.parse(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]).filter(([, v]) => v !== "")));
  if (await maybeOne(service(), "select 1 from organizations where slug = $1", [input.slug])) throw new Error(`Slug "${input.slug}" is taken`);
  const owner = await ownerUserId(input.owner_email);
  const org = await tx(async (c) => {
    const o = await one<Org>(c, `insert into organizations (name, slug, industry, timezone, status, texting_enabled, default_owner_user_id, created_at)
                                 values ($1, $2, $3, $4, 'onboarding', false, $5, $6) returning *`,
      [input.name, input.slug, input.industry, input.timezone, owner.id, now()]);
    await q(c, `insert into memberships (org_id, user_id, role, display_name, email, round_robin_weight) values ($1, $2, 'owner', $3, $4, 0)
                on conflict (org_id, user_id) do update set role = 'owner', active = true`,
      [o.id, owner.id, input.owner_name || input.owner_email.split("@")[0], input.owner_email]);
    return o;
  });
  await auditOrg(ctx, org, "admin.create_org", { ...input, owner_user_id: owner.id, invited: owner.invited });
  log.info("admin.create_org", { org_id: org.id, invited: owner.invited });
  done();
  redirect(`/admin/orgs/${org.id}?created=1`);
}

async function targetOrg(form: FormData) {
  const id = String(form.get("org_id") ?? "");
  const org = await maybeOne<Org>(service(), "select * from organizations where id = $1", [id]);
  if (!org) throw new Error("Organization not found");
  return org;
}

/** Texting on/off reflects carrier registration approval. Only the platform owner flips it. */
export async function setTextingAction(form: FormData) {
  const ctx = await requirePlatformAdmin();
  const org = await targetOrg(form);
  const enabled = form.get("enabled") === "true";
  if (enabled === org.texting_enabled) return done(org.id);
  await q(service(), "update organizations set texting_enabled = $2 where id = $1", [org.id, enabled]);
  await auditOrg(ctx, org, "admin.set_texting_enabled", { texting_enabled: { from: org.texting_enabled, to: enabled } });
  done(org.id);
}

export async function setBaaAction(form: FormData) {
  const ctx = await requirePlatformAdmin();
  const org = await targetOrg(form);
  if (form.get("op") === "clear") {
    await q(service(), "update organizations set hipaa_baa_confirmed_at = null where id = $1", [org.id]);
    await auditOrg(ctx, org, "admin.clear_hipaa_baa", { hipaa_baa_confirmed_at: { from: org.hipaa_baa_confirmed_at, to: null } });
    return done(org.id);
  }
  const checked = BAA_VENDORS.filter((_, i) => form.get(`vendor_${i}`) === "on");
  if (checked.length !== BAA_VENDORS.length || form.get("confirm") !== "on") {
    throw new Error("Confirm a signed BAA for every listed vendor before recording it.");
  }
  const at = now();
  await q(service(), "update organizations set hipaa_baa_confirmed_at = $2 where id = $1", [org.id, at]);
  await auditOrg(ctx, org, "admin.confirm_hipaa_baa", { hipaa_baa_confirmed_at: { from: org.hipaa_baa_confirmed_at, to: at }, vendors: checked, note: String(form.get("note") ?? "") || null });
  done(org.id);
}

export async function setOrgStatusAction(form: FormData) {
  const ctx = await requirePlatformAdmin();
  const org = await targetOrg(form);
  const status = String(form.get("status"));
  if (!["onboarding", "live", "paused"].includes(status) || status === org.status) return done(org.id);
  if (status === "live" && isMedicalIndustry(org.industry) && !org.hipaa_baa_confirmed_at) throw new Error("Medical orgs cannot go live until the HIPAA BAAs are confirmed.");
  await q(service(), "update organizations set status = $2 where id = $1", [org.id, status]);
  await auditOrg(ctx, org, "admin.set_status", { status: { from: org.status, to: status } });
  done(org.id);
}
