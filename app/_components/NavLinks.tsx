"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items, className, mobile }: { items: Array<{ href: string; label: string; badge?: number }>; className?: string; mobile?: boolean }) {
  const path = usePathname();
  return (
    <nav className={className}>
      {items.map((i) => {
        const active = path === i.href || path.startsWith(i.href.split("/").slice(0, 2).join("/") + "/") || (i.href.startsWith("/settings") && path.startsWith("/settings"));
        return (
          <Link key={i.href} href={i.href} className={`relative rounded-lg px-3 py-2 text-sm ${mobile ? "text-center text-xs" : ""} ${active ? "bg-brand/10 font-medium text-brand" : "hover:bg-black/5 dark:hover:bg-white/10"}`}>
            {i.label}
            {i.badge ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{i.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
