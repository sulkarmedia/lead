// Settings shell: admin-only sub-navigation. Each page also calls requireAdmin() itself.
import { requireAdmin } from "@/lib/auth";
import { SettingsNav } from "./_components/SettingsNav";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div>
      <SettingsNav />
      {children}
    </div>
  );
}
