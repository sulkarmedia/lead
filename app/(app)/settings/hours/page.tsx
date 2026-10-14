// /settings/hours: org-level bookable hours (availability row with user_id null), optional per-rep
// overrides, blackout dates, and the org's Sunday/holiday sending switches.
import { requireAdmin } from "@/lib/auth";
import { q, withUserDb } from "@/lib/db";
import type { Availability, Membership } from "@/lib/db/types";
import { Badge, Button, Card, CardTitle, Empty, Label, PageHeader, Select } from "../../../_components/ui";
import { deleteAvailabilityAction, saveSendDaysAction } from "../../../_actions/settings";
import { ActionForm, SubmitButton } from "../_components/ActionForm";
import { AvailabilityForm } from "./_components/AvailabilityForm";

export const dynamic = "force-dynamic";

export default async function HoursSettings({ searchParams }: { searchParams: Promise<{ rep?: string }> }) {
  const ctx = await requireAdmin();
  const { rep } = await searchParams;
  const { rows, members } = await withUserDb(ctx.user.id, async (c) => ({
    rows: await q<Availability>(c, "select * from availability where org_id = $1", [ctx.org.id]),
    members: await q<Membership>(c, "select * from memberships where org_id = $1 and active order by display_name", [ctx.org.id]),
  }));
  const orgRow = rows.find((r) => !r.user_id) ?? null;
  const overrides = rows.filter((r) => r.user_id);
  const name = (uid: string | null) => members.find((m) => m.user_id === uid)?.display_name ?? "Former member";
  const addable = members.filter((m) => !overrides.some((o) => o.user_id === m.user_id));
  const adding = rep && addable.some((m) => m.user_id === rep) ? rep : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Hours">Times the assistant can offer for appointments, in the business time zone ({ctx.org.timezone}).</PageHeader>

      <Card>
        <CardTitle>Business hours {!orgRow && <Badge tone="yellow">not saved yet</Badge>}</CardTitle>
        <AvailabilityForm row={orgRow} userId={null} />
      </Card>

      <Card>
        <CardTitle>Automated messages on Sundays and holidays</CardTitle>
        <ActionForm action={saveSendDaysAction} className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="send_sundays" defaultChecked={ctx.org.send_sundays} /> Send automated messages on Sundays</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="send_holidays" defaultChecked={ctx.org.send_holidays} /> Send automated messages on US federal holidays</label>
          <p className="text-xs muted">Either way, texts only go out 08:00–21:00 in the lead's time zone (stricter state rules apply). Replies to a lead's own message aren't affected.</p>
          <SubmitButton>Save</SubmitButton>
        </ActionForm>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Per-rep hours (optional)</h2>
        <p className="text-xs muted">A rep without their own hours uses the business hours. A connected Google Calendar also blocks busy times.</p>
        {overrides.length === 0 && !adding && <Empty>No per-rep hours.</Empty>}
        {overrides.map((o) => (
          <Card key={o.id}>
            <div className="mb-2 flex items-center justify-between">
              <CardTitle className="mb-0">{name(o.user_id)}</CardTitle>
              <form action={deleteAvailabilityAction}>
                <input type="hidden" name="user_id" value={o.user_id!} />
                <Button variant="ghost" type="submit" className="text-red-600">Remove</Button>
              </form>
            </div>
            <AvailabilityForm row={o} userId={o.user_id} />
          </Card>
        ))}
        {adding && (
          <Card>
            <CardTitle>{name(adding)} (new)</CardTitle>
            <AvailabilityForm row={orgRow ? { ...orgRow, user_id: adding } : null} userId={adding} />
          </Card>
        )}
        {addable.length > 0 && (
          <form className="flex items-end gap-2" method="get">
            <Label className="flex-1">Add hours for
              <Select name="rep" defaultValue="">{addable.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
            </Label>
            <Button variant="secondary" type="submit">Add</Button>
          </form>
        )}
      </section>
    </div>
  );
}
