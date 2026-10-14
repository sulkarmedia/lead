// Weekly hours / slot settings for the org row (userId null) or one rep's override. Shared by
// /settings/hours and the onboarding wizard's Hours step.
import type { Availability } from "@/lib/db/types";
import { Input, Label, Textarea } from "../../../../_components/ui";
import { saveAvailabilityAction } from "../../../../_actions/settings";
import { ActionForm, SubmitButton } from "../../_components/ActionForm";

const DAYS: Array<[string, string]> = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const DEFAULT_WEEK: Availability["weekly_hours"] = {
  mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]], fri: [["09:00", "18:00"]], sat: [["10:00", "16:00"]], sun: [],
};

export function AvailabilityForm({ row, userId }: { row: Availability | null; userId: string | null }) {
  const week = row?.weekly_hours ?? DEFAULT_WEEK;
  return (
    <ActionForm action={saveAvailabilityAction} className="space-y-3">
      <input type="hidden" name="user_id" value={userId ?? ""} />
      <div className="grid gap-2 sm:grid-cols-2">
        {DAYS.map(([k, label]) => (
          <Label key={k} className="grid grid-cols-[6rem_1fr] items-center gap-2 space-y-0">
            <span>{label}</span>
            <Input name={`hours_${k}`} defaultValue={(week[k] ?? []).map(([a, b]) => `${a}-${b}`).join(", ")} placeholder="closed" aria-label={`${label} hours`} />
          </Label>
        ))}
      </div>
      <p className="text-xs muted">Ranges like 09:00-12:00, 13:00-18:00. Leave empty for closed.</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Label>Slot (min)<Input name="slot_minutes" type="number" min={10} max={240} defaultValue={row?.slot_minutes ?? 45} /></Label>
        <Label>Buffer (min)<Input name="buffer_minutes" type="number" min={0} max={240} defaultValue={row?.buffer_minutes ?? 15} /></Label>
        <Label>Min notice (min)<Input name="min_notice_minutes" type="number" min={0} max={10080} defaultValue={row?.min_notice_minutes ?? 120} /></Label>
        <Label>Days ahead<Input name="max_days_ahead" type="number" min={1} max={90} defaultValue={row?.max_days_ahead ?? 7} /></Label>
      </div>
      <Label hint="One date per line (YYYY-MM-DD). No bookings on these days.">Blackout dates
        <Textarea name="blackout_dates" defaultValue={(row?.blackout_dates ?? []).join("\n")} className="min-h-16" />
      </Label>
      <SubmitButton>Save hours</SubmitButton>
    </ActionForm>
  );
}
