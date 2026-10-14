// Per-org admin controls (server component): texting switch, HIPAA BAA confirmation, status, impersonate.
import { Badge, Button, Input, Select } from "../../../_components/ui";
import { setBaaAction, setOrgStatusAction, setTextingAction } from "../../../_actions/admin";
import { switchOrg } from "../../../_actions/org";
import { fmtTime } from "@/lib/format";
import { isMedicalIndustry } from "@/lib/compliance";
import { BAA_VENDORS } from "./baa";

export function TextingToggle({ org }: { org: { id: string; texting_enabled: boolean } }) {
  return (
    <form action={setTextingAction} className="flex items-center gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <input type="hidden" name="enabled" value={org.texting_enabled ? "false" : "true"} />
      <Badge tone={org.texting_enabled ? "green" : "gray"}>Texting {org.texting_enabled ? "on" : "off"}</Badge>
      <Button variant={org.texting_enabled ? "secondary" : "primary"} className="px-2 py-1 text-xs" title="Reflects carrier registration (10DLC) approval">
        {org.texting_enabled ? "Turn off" : "Carrier approved: turn on"}
      </Button>
    </form>
  );
}

export function StatusSelect({ org }: { org: { id: string; status: string } }) {
  return (
    <form action={setOrgStatusAction} className="flex items-center gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <Select name="status" defaultValue={org.status} className="w-36 py-1 text-xs">
        <option value="onboarding">onboarding</option>
        <option value="live">live</option>
        <option value="paused">paused</option>
      </Select>
      <Button variant="secondary" className="px-2 py-1 text-xs">Set status</Button>
    </form>
  );
}

export function BaaForm({ org, tz }: { org: { id: string; industry: string; hipaa_baa_confirmed_at: Date | null }; tz: string }) {
  const medical = isMedicalIndustry(org.industry);
  if (org.hipaa_baa_confirmed_at) {
    return (
      <form action={setBaaAction} className="flex flex-wrap items-center gap-2 text-xs">
        <input type="hidden" name="org_id" value={org.id} />
        <input type="hidden" name="op" value="clear" />
        <Badge tone="green">BAAs confirmed {fmtTime(org.hipaa_baa_confirmed_at, tz, "LLL d, yyyy")}</Badge>
        <Button variant="ghost" className="px-2 py-1 text-xs">Clear</Button>
      </form>
    );
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none">
        <Badge tone={medical ? "red" : "gray"}>{medical ? "HIPAA BAAs missing (blocks go-live)" : "No BAAs recorded"}</Badge>
      </summary>
      <form action={setBaaAction} className="mt-2 space-y-1.5 rounded-lg border border-app p-3">
        <input type="hidden" name="org_id" value={org.id} />
        <div className="font-medium">Signed HIPAA business associate agreements are in place with:</div>
        {BAA_VENDORS.map((v, i) => (
          <label key={v} className="flex items-center gap-2"><input type="checkbox" name={`vendor_${i}`} required /> {v}</label>
        ))}
        <Input name="note" placeholder="Where the signed copies are filed (optional)" className="py-1 text-xs" />
        <label className="flex items-start gap-2 pt-1"><input type="checkbox" name="confirm" required className="mt-0.5" /> I confirm every vendor above has a signed BAA covering this organization's lead data.</label>
        <Button className="px-2 py-1 text-xs">Record BAA confirmation</Button>
      </form>
    </details>
  );
}

export function ImpersonateButton({ orgId }: { orgId: string }) {
  return (
    <form action={switchOrg}>
      <input type="hidden" name="org_id" value={orgId} />
      <Button variant="secondary" className="px-2 py-1 text-xs" title="Switch into this org (audited)">Impersonate</Button>
    </form>
  );
}
