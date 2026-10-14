import Link from "next/link";
import { getOrgContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { maybeOne, service } from "@/lib/db";
import { OrgSwitcher } from "../_components/OrgSwitcher";
import { NavLinks } from "../_components/NavLinks";
import { syncClock } from "@/lib/clock-sync";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await syncClock();
  const ctx = await getOrgContext();
  const counts = await maybeOne<{ attention: number }>(service(),
    `select ((select count(*) from messages where org_id = $1 and status in ('pending_approval', 'failed'))
           + (select count(*) from leads where org_id = $1 and ai_status = 'paused' and handoff_at is not null))::int as attention`, [ctx.org.id]);
  const nav = [
    { href: "/inbox", label: "Inbox", badge: counts?.attention || undefined },
    { href: "/leads", label: "Leads" },
    { href: "/calendar", label: "Calendar" },
    ...(ctx.isAdmin ? [{ href: "/dashboard", label: "Dashboard" }] : []),
    { href: "/simulator", label: "Simulator" },
    ...(ctx.isAdmin ? [{ href: "/settings/playbook", label: "Settings" }, { href: "/onboarding", label: "Setup" }] : []),
    ...(ctx.isPlatformAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-56 shrink-0 border-r border-app p-4 md:block">
        <Link href="/inbox" className="mb-6 block text-lg font-semibold">{env.appName}</Link>
        <OrgSwitcher orgs={ctx.orgs} current={ctx.org.id} />
        <NavLinks items={nav} className="mt-4 flex flex-col gap-1" />
        <div className="mt-8 text-xs muted">
          {ctx.user.email}
          <br />
          {ctx.role.replace("_", " ")}
          <form action="/auth/logout" method="post"><button className="mt-1 underline">Sign out</button></form>
        </div>
      </aside>
      <div className="min-w-0 flex-1 pb-20 md:pb-0">
        {env.dryRun && (
          <div className="bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-800 dark:text-amber-200">
            DRY RUN — no texts or emails reach real people. Messages appear in the simulator.
          </div>
        )}
        {ctx.isPlatformAdmin && !ctx.membership && (
          <div className="bg-purple-500/15 px-4 py-1.5 text-center text-xs">Viewing {ctx.org.name} as platform admin (audited)</div>
        )}
        <header className="flex items-center justify-between border-b border-app px-4 py-3 md:hidden">
          <span className="font-semibold">{ctx.org.name}</span>
          <OrgSwitcher orgs={ctx.orgs} current={ctx.org.id} compact />
        </header>
        <main className="mx-auto max-w-6xl p-4">{children}</main>
      </div>
      <NavLinks items={nav.slice(0, 5)} className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-app bg-[var(--card)] px-2 py-2 md:hidden" mobile />
    </div>
  );
}
