"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/settings/playbook", label: "Playbook" },
  { href: "/settings/knowledge", label: "Knowledge" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/hours", label: "Hours" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/onboarding", label: "Setup wizard" },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-app px-4 pb-2" aria-label="Settings">
      {ITEMS.map((i) => {
        const active = path === i.href || path.startsWith(i.href + "/");
        return (
          <Link key={i.href} href={i.href} className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${active ? "bg-brand/10 font-medium text-brand" : "hover:bg-black/5 dark:hover:bg-white/10"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
