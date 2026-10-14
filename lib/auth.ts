// Who is signed in, and which org they're working in. Supabase Auth owns sessions; DEV_LOGIN
// (local only, refused in production) signs in as a seeded user for development and e2e tests.
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { env } from "./env";
import { maybeOne, q, service, withUserDb } from "./db";
import type { Membership, Org } from "./db/types";
import { now } from "./clock";

export interface SessionUser { id: string; email: string | null }

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl!, env.supabaseAnonKey!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          /* called from a server component: middleware refreshes the session instead */
        }
      },
    },
  });
}

export async function getUser(): Promise<SessionUser | null> {
  const store = await cookies();
  if (env.devLogin) {
    const id = store.get("dev_user")?.value;
    if (!id) return null;
    const u = await maybeOne<{ id: string; email: string }>(service(), "select id, email from auth.users where id = $1", [id]);
    return u ? { id: u.id, email: u.email } : null;
  }
  if (!env.supabaseUrl || !env.supabaseAnonKey) return null;
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  return u;
}

export interface OrgContext {
  user: SessionUser;
  org: Org;
  membership: Membership | null; // null when a platform admin is viewing another org
  role: "owner" | "admin" | "rep" | "platform_admin";
  isAdmin: boolean;
  isPlatformAdmin: boolean;
  orgs: Array<{ id: string; name: string }>;
}

export async function getOrgContext(): Promise<OrgContext> {
  const user = await requireUser();
  const store = await cookies();
  const isPlatformAdmin = !!(await maybeOne(service(), "select 1 from platform_admins where user_id = $1", [user.id]));
  const orgs = await q<{ id: string; name: string }>(service(),
    isPlatformAdmin ? "select id, name from organizations order by name" : "select o.id, o.name from organizations o join memberships m on m.org_id = o.id where m.user_id = $1 and m.active order by o.name",
    isPlatformAdmin ? [] : [user.id]);
  if (orgs.length === 0) redirect(isPlatformAdmin ? "/admin" : "/no-access");
  const wanted = store.get("org_id")?.value;
  const orgId = orgs.find((o) => o.id === wanted)?.id ?? orgs[0].id;
  // Read through RLS so access is enforced by the database, not just this code.
  const org = await withUserDb(user.id, (c) => maybeOne<Org>(c, "select * from organizations where id = $1", [orgId]));
  if (!org) redirect("/no-access");
  const membership = await maybeOne<Membership>(service(), "select * from memberships where org_id = $1 and user_id = $2 and active", [orgId, user.id]);
  const role = membership?.role ?? "platform_admin";
  return { user, org, membership, role, isAdmin: role !== "rep", isPlatformAdmin, orgs };
}

export async function requireAdmin(): Promise<OrgContext> {
  const ctx = await getOrgContext();
  if (!ctx.isAdmin) redirect("/inbox");
  return ctx;
}

/** RLS-checked: may this user edit this lead? */
export async function canEditLead(userId: string, leadId: string): Promise<boolean> {
  const r = await withUserDb(userId, (c) => maybeOne<{ ok: boolean }>(c, "select app.can_edit_lead($1) as ok", [leadId]));
  return !!r?.ok;
}

export async function audit(ctx: Pick<OrgContext, "user" | "org" | "isPlatformAdmin" | "membership">, action: string, entity: string, entityId: string | null, diff?: unknown) {
  await q(service(), "insert into audit_log (org_id, actor, action, entity, entity_id, diff, created_at) values ($1, $2, $3, $4, $5, $6, $7)", [
    ctx.org.id, `${ctx.isPlatformAdmin && !ctx.membership ? "platform_admin" : "user"}:${ctx.user.email ?? ctx.user.id}`, action, entity, entityId, diff ? JSON.stringify(diff) : null, now(),
  ]);
}
