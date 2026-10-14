"use server";
// Settings actions (owners/admins). Every action checks requireAdmin(), writes with the service
// connection scoped by ctx.org.id, and records the change in audit_log. Nothing here can switch off
// consent, opt-out, the send-window clamp or the frequency cap: those live in lib/compliance.
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireAdmin, type OrgContext } from "@/lib/auth";
import { maybeOne, one, q, service } from "@/lib/db";
import type { KnowledgeItem, Membership, Playbook } from "@/lib/db/types";
import { env } from "@/lib/env";
import { encrypt } from "@/lib/crypto";
import { normalizeEmail, normalizePhone } from "@/lib/leads/normalize";
import { ensureUser } from "@/lib/seed";
import { setProgressKey } from "@/lib/onboarding";
import {
  approvePlaybook, extractFacts, fetchSitePages, insertKnowledgeItems, introTemplateProblems, KNOWLEDGE_KINDS, KnowledgeDraft,
  PlaybookInput, playbookToInput, proposeKnowledge, savePlaybookVersion,
} from "@/lib/playbook-generator";
import type { ActionResult } from "../(app)/settings/_components/ActionForm";

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : (e as Error).message });
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const bool = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "true";
const int = (f: FormData, k: string, min: number, max: number, label = k) => {
  const n = Number(str(f, k));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// ---------------------------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------------------------

export async function savePlaybookAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const id = str(form, "playbook_id") || null;
    const input = PlaybookInput.parse(JSON.parse(str(form, "playbook_json")));
    const problems = introTemplateProblems(input.intro_template, ctx.org.name);
    if (problems.length) return { ok: false, error: `Intro message ${problems.join("; ")}` };
    const before = id ? await maybeOne<Playbook>(service(), "select * from playbooks where id = $1 and org_id = $2", [id, ctx.org.id]) : null;
    if (id && !before) return { ok: false, error: "Playbook not found" };
    const saved = await savePlaybookVersion(service(), ctx.org.id, id, input);
    const changes = before ? changedKeys(playbookToInput(before) as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>) : ["created"];
    await audit(ctx, id ? "playbook.update" : "playbook.create", "playbook", saved.id, { version: saved.version, changed: changes, after: input });
    revalidatePath("/settings/playbook");
    revalidatePath("/onboarding");
    return { ok: true, message: `Saved as version ${saved.version}. It needs approval again.` };
  } catch (e) {
    return fail(e);
  }
}

export async function approvePlaybookAction(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = str(form, "playbook_id");
  const pb = await approvePlaybook(service(), ctx.org.id, id, ctx.user.id);
  if (!pb) throw new Error("Playbook not found");
  await audit(ctx, "playbook.approve", "playbook", id, { version: pb.version });
  revalidatePath("/settings/playbook");
  revalidatePath("/onboarding");
}

// ---------------------------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------------------------

const KnowledgeForm = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().trim().min(1, "title is required").max(200),
  body: z.string().trim().min(1, "body is required").max(5000),
  source_url: z.string().trim().max(1000).refine((s) => !s || /^https?:\/\//i.test(s), "source URL must start with http(s)://"),
  active: z.boolean(),
});

export async function saveKnowledgeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const id = str(form, "id") || null;
    const k = KnowledgeForm.parse({ kind: str(form, "kind"), title: str(form, "title"), body: str(form, "body"), source_url: str(form, "source_url"), active: id ? bool(form, "active") : true });
    if (id) {
      const before = await maybeOne<KnowledgeItem>(service(), "select * from knowledge_items where id = $1 and org_id = $2", [id, ctx.org.id]);
      if (!before) return { ok: false, error: "Item not found" };
      await q(service(), "update knowledge_items set kind = $3, title = $4, body = $5, source_url = $6, active = $7 where id = $1 and org_id = $2",
        [id, ctx.org.id, k.kind, k.title, k.body, k.source_url || null, k.active]);
      await audit(ctx, "knowledge.update", "knowledge_item", id, { before: { kind: before.kind, title: before.title, body: before.body, source_url: before.source_url, active: before.active }, after: k });
    } else {
      const row = await one<{ id: string }>(service(), "insert into knowledge_items (org_id, kind, title, body, source_url, active) values ($1, $2, $3, $4, $5, true) returning id",
        [ctx.org.id, k.kind, k.title, k.body, k.source_url || null]);
      await audit(ctx, "knowledge.create", "knowledge_item", row.id, k);
    }
    revalidatePath("/settings/knowledge");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleKnowledgeAction(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = str(form, "id");
  const row = await maybeOne<{ active: boolean }>(service(), "update knowledge_items set active = not active where id = $1 and org_id = $2 returning active", [id, ctx.org.id]);
  if (row) await audit(ctx, "knowledge.toggle", "knowledge_item", id, { active: row.active });
  revalidatePath("/settings/knowledge");
}

export async function deleteKnowledgeAction(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = str(form, "id");
  const row = await maybeOne<KnowledgeItem>(service(), "delete from knowledge_items where id = $1 and org_id = $2 returning *", [id, ctx.org.id]);
  if (row) await audit(ctx, "knowledge.delete", "knowledge_item", id, { kind: row.kind, title: row.title, body: row.body });
  revalidatePath("/settings/knowledge");
}

/** Re-scan the website: fetch + extract + propose items. Returns proposals; nothing is saved. */
export async function rescanWebsiteAction(url: string): Promise<{ ok: true; items: KnowledgeDraft[]; pages: number; warning: string | null } | { ok: false; error: string }> {
  const ctx = await requireAdmin();
  try {
    const target = url.trim() || ctx.org.website_url;
    if (!target) return { ok: false, error: "Enter the website URL first." };
    const pages = await fetchSitePages(target);
    const facts = await extractFacts(pages);
    const existing = await q<{ title: string }>(service(), "select title from knowledge_items where org_id = $1", [ctx.org.id]);
    const r = await proposeKnowledge(ctx.org, facts, existing.map((e) => e.title));
    await audit(ctx, "knowledge.rescan", "organization", ctx.org.id, { url: target, pages: pages.length, proposed: r.items.length });
    return { ok: true, items: r.items, pages: pages.length, warning: r.warning };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Save the proposals the owner approved. */
export async function addKnowledgeDraftsAction(items: KnowledgeDraft[]): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const parsed = z.array(KnowledgeDraft).max(100).parse(items);
    const n = await insertKnowledgeItems(service(), ctx.org.id, parsed);
    await audit(ctx, "knowledge.add_from_scan", "organization", ctx.org.id, { count: n, titles: parsed.map((p) => p.title) });
    revalidatePath("/settings/knowledge");
    return { ok: true, message: `Added ${n} item${n === 1 ? "" : "s"}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function saveInventoryFeedAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const url = str(form, "inventory_feed_url");
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: "Enter a full http(s):// URL." };
    await setProgressKey(service(), ctx.org.id, "inventory_feed_url", url || null);
    await audit(ctx, "settings.inventory_feed", "organization", ctx.org.id, { inventory_feed_url: url || null });
    revalidatePath("/settings/knowledge");
    return { ok: true, message: url ? "Saved. The feed syncs nightly into inventory items." : "Feed removed." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------

const ROLES = ["owner", "admin", "rep"] as const;

/** Find or create the auth user for an invite: Supabase Auth Admin invite, or the local shim with DEV_LOGIN. */
async function inviteUser(email: string): Promise<string> {
  const existing = await maybeOne<{ id: string }>(service(), "select id from auth.users where lower(email) = lower($1)", [email]);
  if (existing) return existing.id;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.supabaseUrl && serviceKey && !env.devLogin) {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/invite`, {
      method: "POST",
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email, redirect_to: `${env.appUrl}/auth/callback` }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; user?: { id?: string }; msg?: string; error_description?: string; message?: string };
    if (!res.ok) throw new Error(`Invite failed: ${body.msg ?? body.error_description ?? body.message ?? res.status}`);
    const id = body.id ?? body.user?.id;
    if (!id) throw new Error("Invite failed: no user id returned");
    return id;
  }
  if (env.devLogin) return ensureUser(service(), email);
  throw new Error("Inviting needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or DEV_LOGIN locally).");
}

function canGrant(ctx: OrgContext, role: string) {
  return role !== "owner" || ctx.role === "owner" || ctx.isPlatformAdmin;
}

export async function inviteMemberAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const email = normalizeEmail(str(form, "email"));
    if (!email) return { ok: false, error: "Enter a valid email." };
    const role = z.enum(ROLES).parse(str(form, "role") || "rep");
    if (!canGrant(ctx, role)) return { ok: false, error: "Only an owner can add another owner." };
    const rawPhone = str(form, "mobile_phone");
    const mobile = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !mobile) return { ok: false, error: "That mobile number doesn't look valid." };
    const name = str(form, "display_name") || email.split("@")[0];
    const already = await maybeOne(service(), "select 1 from memberships m join auth.users u on u.id = m.user_id where m.org_id = $1 and lower(u.email) = lower($2)", [ctx.org.id, email]);
    if (already) return { ok: false, error: "That person is already on the team." };
    const userId = await inviteUser(email);
    const m = await one<{ id: string }>(service(),
      `insert into memberships (org_id, user_id, role, display_name, email, mobile_phone) values ($1, $2, $3, $4, $5, $6)
       on conflict (org_id, user_id) do update set active = true, role = excluded.role returning id`,
      [ctx.org.id, userId, role, name.slice(0, 80), email, mobile]);
    await audit(ctx, "team.invite", "membership", m.id, { email, role, mobile_phone: mobile });
    revalidatePath("/settings/team");
    revalidatePath("/onboarding");
    return { ok: true, message: `Invited ${email}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateMemberAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const id = str(form, "membership_id");
    const before = await maybeOne<Membership>(service(), "select * from memberships where id = $1 and org_id = $2", [id, ctx.org.id]);
    if (!before) return { ok: false, error: "Member not found" };
    const role = z.enum(ROLES).parse(str(form, "role"));
    if ((before.role === "owner" || role === "owner") && role !== before.role && !canGrant(ctx, "owner")) return { ok: false, error: "Only an owner can change owner roles." };
    const rawPhone = str(form, "mobile_phone");
    const mobile = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !mobile) return { ok: false, error: "That mobile number doesn't look valid." };
    const after = {
      role,
      display_name: (str(form, "display_name") || before.display_name).slice(0, 80),
      mobile_phone: mobile,
      notify_sms: bool(form, "notify_sms"),
      notify_email: bool(form, "notify_email"),
      round_robin_weight: int(form, "round_robin_weight", 0, 100, "Round-robin weight"),
      active: bool(form, "active"),
    };
    if (before.role === "owner" && (after.role !== "owner" || !after.active)) {
      const owners = await one<{ n: number }>(service(), "select count(*)::int as n from memberships where org_id = $1 and role = 'owner' and active and id <> $2", [ctx.org.id, id]);
      if (owners.n === 0) return { ok: false, error: "The org needs at least one active owner." };
    }
    if (after.notify_sms && !after.mobile_phone) after.notify_sms = false;
    await q(service(),
      `update memberships set role = $3, display_name = $4, mobile_phone = $5, notify_sms = $6, notify_email = $7, round_robin_weight = $8, active = $9 where id = $1 and org_id = $2`,
      [id, ctx.org.id, after.role, after.display_name, after.mobile_phone, after.notify_sms, after.notify_email, after.round_robin_weight, after.active]);
    const prev = { role: before.role, display_name: before.display_name, mobile_phone: before.mobile_phone, notify_sms: before.notify_sms, notify_email: before.notify_email, round_robin_weight: before.round_robin_weight, active: before.active };
    await audit(ctx, "team.update", "membership", id, { before: prev, after });
    revalidatePath("/settings/team");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function saveAssignmentAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const mode = z.enum(["round_robin", "single_owner"]).parse(str(form, "assignment_mode"));
    const owner = str(form, "default_owner_user_id") || null;
    const backup = str(form, "backup_user_id") || null;
    for (const u of [owner, backup]) {
      if (u && !(await maybeOne(service(), "select 1 from memberships where org_id = $1 and user_id = $2 and active", [ctx.org.id, u]))) return { ok: false, error: "Pick an active team member." };
    }
    if (mode === "single_owner" && !owner) return { ok: false, error: "Single owner mode needs a default owner." };
    await q(service(), "update organizations set assignment_mode = $2, default_owner_user_id = $3, backup_user_id = $4 where id = $1", [ctx.org.id, mode, owner, backup]);
    await audit(ctx, "team.assignment", "organization", ctx.org.id, {
      before: { assignment_mode: ctx.org.assignment_mode, default_owner_user_id: ctx.org.default_owner_user_id, backup_user_id: ctx.org.backup_user_id },
      after: { assignment_mode: mode, default_owner_user_id: owner, backup_user_id: backup },
    });
    revalidatePath("/settings/team");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------------------------

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** "09:00-12:00, 13:00-18:00" → [["09:00","12:00"],["13:00","18:00"]]. Throws on bad input or overlaps. */
function parseRanges(day: string, raw: string): Array<[string, string]> {
  const s = raw.trim();
  if (!s || /^closed$/i.test(s)) return [];
  const out = s.split(/[,;]+/).map((part) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*[-–to ]+\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) throw new Error(`${day}: write ranges like 09:00-18:00`);
    const a = `${m[1].padStart(2, "0")}:${m[2]}`;
    const b = `${m[3].padStart(2, "0")}:${m[4]}`;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a) || !/^([01]\d|2[0-4]):[0-5]\d$/.test(b)) throw new Error(`${day}: bad time`);
    if (b <= a) throw new Error(`${day}: ${a}-${b} ends before it starts`);
    return [a, b] as [string, string];
  }).sort((x, y) => x[0].localeCompare(y[0]));
  for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][1]) throw new Error(`${day}: ranges overlap`);
  return out;
}

export async function saveAvailabilityAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const userId = str(form, "user_id") || null;
    if (userId && !(await maybeOne(service(), "select 1 from memberships where org_id = $1 and user_id = $2", [ctx.org.id, userId]))) return { ok: false, error: "Not a team member." };
    const weekly = Object.fromEntries(DAYS.map((d) => [d, parseRanges(d, str(form, `hours_${d}`))]));
    const blackout = str(form, "blackout_dates").split(/[\s,]+/).filter(Boolean);
    for (const d of blackout) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) return { ok: false, error: `Blackout date "${d}" must be YYYY-MM-DD.` };
    const vals = {
      weekly_hours: weekly,
      slot_minutes: int(form, "slot_minutes", 10, 240, "Slot length"),
      buffer_minutes: int(form, "buffer_minutes", 0, 240, "Buffer"),
      min_notice_minutes: int(form, "min_notice_minutes", 0, 10080, "Minimum notice"),
      max_days_ahead: int(form, "max_days_ahead", 1, 90, "Days ahead"),
      blackout_dates: [...new Set(blackout)].sort(),
    };
    const row = await one<{ id: string }>(service(),
      `insert into availability (org_id, user_id, weekly_hours, slot_minutes, buffer_minutes, min_notice_minutes, max_days_ahead, blackout_dates)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'))
       do update set weekly_hours = excluded.weekly_hours, slot_minutes = excluded.slot_minutes, buffer_minutes = excluded.buffer_minutes,
                     min_notice_minutes = excluded.min_notice_minutes, max_days_ahead = excluded.max_days_ahead, blackout_dates = excluded.blackout_dates
       returning id`,
      [ctx.org.id, userId, JSON.stringify(vals.weekly_hours), vals.slot_minutes, vals.buffer_minutes, vals.min_notice_minutes, vals.max_days_ahead, JSON.stringify(vals.blackout_dates)]);
    await audit(ctx, "hours.save", "availability", row.id, { user_id: userId, ...vals });
    revalidatePath("/settings/hours");
    revalidatePath("/onboarding");
    return { ok: true, message: "Hours saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAvailabilityAction(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const userId = str(form, "user_id");
  if (!userId) return; // the org-level row stays
  const row = await maybeOne<{ id: string }>(service(), "delete from availability where org_id = $1 and user_id = $2 returning id", [ctx.org.id, userId]);
  if (row) await audit(ctx, "hours.delete_override", "availability", row.id, { user_id: userId });
  revalidatePath("/settings/hours");
}

export async function saveSendDaysAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const after = { send_sundays: bool(form, "send_sundays"), send_holidays: bool(form, "send_holidays") };
    await q(service(), "update organizations set send_sundays = $2, send_holidays = $3 where id = $1", [ctx.org.id, after.send_sundays, after.send_holidays]);
    await audit(ctx, "settings.send_days", "organization", ctx.org.id, { before: { send_sundays: ctx.org.send_sundays, send_holidays: ctx.org.send_holidays }, after });
    revalidatePath("/settings/hours");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------------------------

async function upsertIntegration(orgId: string, kind: string, status: string, config: Record<string, unknown>, secretEnc?: string | null) {
  return one<{ id: string }>(service(),
    `insert into integrations (org_id, kind, user_id, status, config, secret_enc, last_error, updated_at)
     values ($1, $2, null, $3, $4, $5, null, now())
     on conflict (org_id, kind, coalesce(user_id, '00000000-0000-0000-0000-000000000000'))
     do update set status = excluded.status, config = excluded.config, secret_enc = coalesce($5, integrations.secret_enc), last_error = null, updated_at = now()
     returning id`,
    [orgId, kind, status, JSON.stringify(config), secretEnc ?? null]);
}

/** Phone number + texting switch. Platform admins only: texting_enabled reflects carrier registration approval. */
export async function savePhoneAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  if (!ctx.isPlatformAdmin) return { ok: false, error: "Only the Leadline team can change the texting number (it's tied to carrier registration)." };
  try {
    const raw = str(form, "sms_from_number");
    const number = raw ? normalizePhone(raw) : null;
    if (raw && !number) return { ok: false, error: "That number doesn't look valid." };
    const sid = str(form, "twilio_messaging_service_sid") || null;
    if (sid && !/^MG[0-9a-fA-F]{32}$/.test(sid)) return { ok: false, error: "Messaging Service SIDs look like MG followed by 32 hex characters." };
    const texting = bool(form, "texting_enabled");
    if (texting && (!number || !sid)) return { ok: false, error: "Texting needs a registered number and a Messaging Service first." };
    await q(service(), "update organizations set sms_from_number = $2, twilio_messaging_service_sid = $3, texting_enabled = $4 where id = $1", [ctx.org.id, number, sid, texting]);
    await upsertIntegration(ctx.org.id, "twilio", texting ? "connected" : number ? "pending" : "not_connected", { number, messaging_service_sid: sid });
    await audit(ctx, "integrations.phone", "organization", ctx.org.id, {
      before: { sms_from_number: ctx.org.sms_from_number, twilio_messaging_service_sid: ctx.org.twilio_messaging_service_sid, texting_enabled: ctx.org.texting_enabled },
      after: { sms_from_number: number, twilio_messaging_service_sid: sid, texting_enabled: texting },
    });
    revalidatePath("/settings/integrations");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function saveAdfAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const raw = str(form, "address");
    const address = raw ? normalizeEmail(raw) : null;
    if (raw && !address) return { ok: false, error: "Enter a valid email address." };
    const row = await upsertIntegration(ctx.org.id, "adf_email", address ? "connected" : "not_connected", address ? { address } : {});
    await audit(ctx, "integrations.adf_email", "integration", row.id, { address });
    revalidatePath("/settings/integrations");
    return { ok: true, message: address ? "ADF leads will go to this address on qualified and appointment set." : "ADF email turned off." };
  } catch (e) {
    return fail(e);
  }
}

export async function saveWebhookAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const url = str(form, "url");
    if (!url) {
      const row = await upsertIntegration(ctx.org.id, "crm_webhook", "not_connected", {});
      await q(service(), "update integrations set secret_enc = null where id = $1", [row.id]);
      await audit(ctx, "integrations.crm_webhook", "integration", row.id, { url: null });
      revalidatePath("/settings/integrations");
      return { ok: true, message: "Webhook turned off." };
    }
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, error: "Enter a full URL." }; }
    if (u.protocol !== "https:" && !(env.devLogin && u.protocol === "http:")) return { ok: false, error: "Webhook URLs must use https://." };
    const existing = await maybeOne<{ secret_enc: string | null }>(service(), "select secret_enc from integrations where org_id = $1 and kind = 'crm_webhook' and user_id is null", [ctx.org.id]);
    const regenerate = bool(form, "regenerate") || !existing?.secret_enc;
    const secret = regenerate ? `whsec_${randomBytes(24).toString("base64url")}` : null;
    const row = await upsertIntegration(ctx.org.id, "crm_webhook", "connected", { url: u.toString() }, secret ? encrypt(secret) : null);
    await audit(ctx, "integrations.crm_webhook", "integration", row.id, { url: u.toString(), secret_rotated: !!secret });
    revalidatePath("/settings/integrations");
    return { ok: true, message: "Webhook saved. Verify the X-Leadline-Signature header with the secret.", ...(secret ? { secret } : {}) };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCapiAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await requireAdmin();
  try {
    const dataset = str(form, "dataset_id");
    const token = str(form, "access_token");
    if (!dataset) {
      const row = await upsertIntegration(ctx.org.id, "capi", "not_connected", {});
      await q(service(), "update integrations set secret_enc = null where id = $1", [row.id]);
      await q(service(), "update organizations set capi_dataset_id = null where id = $1", [ctx.org.id]);
      await audit(ctx, "integrations.capi", "integration", row.id, { dataset_id: null });
      revalidatePath("/settings/integrations");
      return { ok: true, message: "Conversions API turned off." };
    }
    if (!/^\d{5,25}$/.test(dataset)) return { ok: false, error: "The dataset (pixel) id is a number." };
    const existing = await maybeOne<{ secret_enc: string | null }>(service(), "select secret_enc from integrations where org_id = $1 and kind = 'capi' and user_id is null", [ctx.org.id]);
    if (!token && !existing?.secret_enc) return { ok: false, error: "Paste the Conversions API access token." };
    const row = await upsertIntegration(ctx.org.id, "capi", "connected", { dataset_id: dataset }, token ? encrypt(token) : null);
    await q(service(), "update organizations set capi_dataset_id = $2 where id = $1", [ctx.org.id, dataset]);
    await audit(ctx, "integrations.capi", "integration", row.id, { dataset_id: dataset, token_replaced: !!token });
    revalidatePath("/settings/integrations");
    return { ok: true, message: "Conversions API saved." };
  } catch (e) {
    return fail(e);
  }
}
