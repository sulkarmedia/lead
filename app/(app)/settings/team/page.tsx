// /settings/team: memberships (role, name, mobile for handoff alerts, notifications, round-robin
// weight, active), invites, and org-level routing (round robin or single owner, backup handler).
import { requireAdmin } from "@/lib/auth";
import { q, withUserDb } from "@/lib/db";
import type { Membership } from "@/lib/db/types";
import { fmtPhone } from "@/lib/format";
import { Badge, Card, CardTitle, Input, Label, PageHeader, Select } from "../../../_components/ui";
import { saveAssignmentAction, updateMemberAction } from "../../../_actions/settings";
import { ActionForm, SubmitButton } from "../_components/ActionForm";
import { InviteForm } from "./_components/InviteForm";

export const dynamic = "force-dynamic";

export default async function TeamSettings() {
  const ctx = await requireAdmin();
  const members = await withUserDb(ctx.user.id, (c) =>
    q<Membership>(c, "select * from memberships where org_id = $1 order by active desc, role, display_name", [ctx.org.id]));
  const active = members.filter((m) => m.active);
  const canOwner = ctx.role === "owner" || ctx.isPlatformAdmin;

  return (
    <div className="space-y-6">
      <PageHeader title="Team">Reps get handoff alerts by text at their mobile number. New leads are assigned by round robin (weighted) or to a single owner.</PageHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Invite someone</CardTitle>
          <InviteForm canOwner={canOwner} />
        </Card>
        <Card>
          <CardTitle>Lead assignment</CardTitle>
          <ActionForm action={saveAssignmentAction} className="space-y-3">
            <Label>Mode
              <Select name="assignment_mode" defaultValue={ctx.org.assignment_mode}>
                <option value="round_robin">Round robin (by weight)</option>
                <option value="single_owner">Single owner gets every lead</option>
              </Select>
            </Label>
            <Label hint="Gets every lead in single-owner mode; the fallback when nobody is in the rotation.">Default owner
              <Select name="default_owner_user_id" defaultValue={ctx.org.default_owner_user_id ?? ""}>
                <option value="">(none)</option>
                {active.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
              </Select>
            </Label>
            <Label hint="Alerted when a handoff misses its response time.">Backup handler
              <Select name="backup_user_id" defaultValue={ctx.org.backup_user_id ?? ""}>
                <option value="">(none)</option>
                {active.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
              </Select>
            </Label>
            <SubmitButton>Save assignment</SubmitButton>
          </ActionForm>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Members ({active.length} active)</h2>
        <ul className="space-y-2">
          {members.map((m) => (
            <li key={m.id} className={`card p-3 ${m.active ? "" : "opacity-60"}`}>
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className="font-medium">{m.display_name}</span>
                  <Badge tone={m.role === "owner" ? "purple" : m.role === "admin" ? "blue" : "gray"}>{m.role}</Badge>
                  {!m.active && <Badge tone="red">inactive</Badge>}
                  {ctx.org.backup_user_id === m.user_id && <Badge tone="yellow">backup</Badge>}
                  <span className="text-xs muted">{m.email ?? ""} · {m.mobile_phone ? fmtPhone(m.mobile_phone) : "no mobile"} · weight {m.round_robin_weight}</span>
                </summary>
                <ActionForm action={updateMemberAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="membership_id" value={m.id} />
                  <Label>Display name<Input name="display_name" defaultValue={m.display_name} maxLength={80} /></Label>
                  <Label>Role
                    <Select name="role" defaultValue={m.role}>
                      <option value="rep">Rep</option>
                      <option value="admin">Admin</option>
                      <option value="owner" disabled={!canOwner && m.role !== "owner"}>Owner</option>
                    </Select>
                  </Label>
                  <Label hint="For handoff alerts. US numbers.">Mobile phone<Input name="mobile_phone" type="tel" defaultValue={m.mobile_phone ?? ""} /></Label>
                  <Label hint="0 = never assigned new leads.">Round-robin weight<Input name="round_robin_weight" type="number" min={0} max={100} defaultValue={m.round_robin_weight} /></Label>
                  <div className="flex flex-wrap gap-4 text-sm sm:col-span-2">
                    <label className="flex items-center gap-2"><input type="checkbox" name="notify_sms" defaultChecked={m.notify_sms} /> Text alerts</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="notify_email" defaultChecked={m.notify_email} /> Email alerts</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={m.active} /> Active</label>
                  </div>
                  <div className="sm:col-span-2"><SubmitButton>Save</SubmitButton></div>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
