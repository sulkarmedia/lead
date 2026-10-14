// Invite form, shared by /settings/team and the onboarding wizard's Team step.
import { Input, Label, Select } from "../../../../_components/ui";
import { inviteMemberAction } from "../../../../_actions/settings";
import { ActionForm, SubmitButton } from "../../_components/ActionForm";

export function InviteForm({ canOwner }: { canOwner: boolean }) {
  return (
    <ActionForm action={inviteMemberAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label>Email<Input name="email" type="email" required /></Label>
        <Label>Name<Input name="display_name" maxLength={80} /></Label>
        <Label hint="Handoff alerts go here.">Mobile phone<Input name="mobile_phone" type="tel" /></Label>
        <Label>Role
          <Select name="role" defaultValue="rep">
            <option value="rep">Rep</option>
            <option value="admin">Admin</option>
            {canOwner && <option value="owner">Owner</option>}
          </Select>
        </Label>
      </div>
      <SubmitButton>Send invite</SubmitButton>
    </ActionForm>
  );
}
