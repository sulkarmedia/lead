"use client";
// Live updates: Supabase Realtime (postgres_changes on the org's rows) refreshes the page; without
// Realtime configured (local dev) it polls every 5 seconds.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

export function LiveRefresh({ orgId, tables = ["messages", "leads"], supabaseUrl, anonKey }: { orgId: string; tables?: string[]; supabaseUrl?: string | null; anonKey?: string | null }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; router.refresh(); }, 400);
    };
    if (supabaseUrl && anonKey) {
      const sb = createBrowserClient(supabaseUrl, anonKey);
      const ch = sb.channel(`org-${orgId}`);
      for (const t of tables) ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `org_id=eq.${orgId}` }, refresh);
      ch.subscribe();
      return () => { void sb.removeChannel(ch); };
    }
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [orgId, tables.join(","), supabaseUrl, anonKey, router]);
  return null;
}
