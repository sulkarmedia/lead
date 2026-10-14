import { switchOrg } from "../_actions/org";

export function OrgSwitcher({ orgs, current, compact }: { orgs: Array<{ id: string; name: string }>; current: string; compact?: boolean }) {
  if (orgs.length <= 1) return compact ? null : <div className="text-sm font-medium">{orgs[0]?.name}</div>;
  return (
    <form action={switchOrg}>
      <select name="org_id" defaultValue={current} className={`w-full rounded-lg border border-app bg-transparent px-2 py-1.5 text-sm ${compact ? "max-w-40" : ""}`}>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <button className="mt-1 text-xs underline">Switch</button>
    </form>
  );
}
