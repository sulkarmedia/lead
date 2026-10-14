import { env } from "@/lib/env";
import { q, service } from "@/lib/db";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const devUsers = env.devLogin
    ? await q<{ id: string; email: string; role: string | null; org: string | null }>(service(),
        `select u.id, u.email, coalesce(m.role::text, case when pa.user_id is not null then 'platform admin' end) as role, o.name as org
           from auth.users u left join memberships m on m.user_id = u.id left join organizations o on o.id = m.org_id
           left join platform_admins pa on pa.user_id = u.id order by o.name nulls first, m.role, u.email limit 50`).catch(() => [])
    : [];
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <div>
        <div className="text-2xl font-semibold">{env.appName}</div>
        <p className="text-sm muted">Sign in to your inbox.</p>
      </div>
      {env.supabaseUrl && env.supabaseAnonKey && <LoginForm supabaseUrl={env.supabaseUrl} anonKey={env.supabaseAnonKey} />}
      {env.devLogin && (
        <div className="card p-4">
          <div className="mb-2 text-xs font-semibold uppercase muted">Dev login (local only)</div>
          {devUsers.length === 0 && <p className="text-sm muted">No users yet. Run <code>npm run seed</code>.</p>}
          <ul className="space-y-1">
            {devUsers.map((u) => (
              <li key={u.id + (u.org ?? "")}>
                <a className="block rounded px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10" href={`/auth/dev?user=${u.id}`}>
                  {u.email} <span className="muted">· {u.role ?? "no role"}{u.org ? ` · ${u.org}` : ""}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
