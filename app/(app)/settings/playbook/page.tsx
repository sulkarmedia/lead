// /settings/playbook: edit the org's playbook (saving makes a new version that needs approval) with a
// test chat beside it. The agent keeps using the latest playbook; approval state is shown here and
// gates going live.
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { q, withUserDb } from "@/lib/db";
import type { Playbook } from "@/lib/db/types";
import { fmtTime } from "@/lib/format";
import { DEFAULT_NO_REPLY, DEFAULT_WENT_QUIET } from "@/lib/cadence";
import { defaultPlaybookInput, playbookToInput } from "@/lib/playbook-generator";
import { Badge, Button, PageHeader } from "../../../_components/ui";
import { approvePlaybookAction, savePlaybookAction } from "../../../_actions/settings";
import { PlaybookEditor } from "./_components/PlaybookEditor";
import { TestChat } from "./_components/TestChat";

export const dynamic = "force-dynamic";

export default async function PlaybookSettings({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const ctx = await requireAdmin();
  const { id } = await searchParams;
  const playbooks = await withUserDb(ctx.user.id, (c) =>
    q<Playbook & { approver: string | null }>(c,
      `select p.*, (select display_name from memberships m where m.org_id = p.org_id and m.user_id = p.approved_by) as approver
         from playbooks p where p.org_id = $1 order by p.approved_at desc nulls last, p.created_at`, [ctx.org.id]));
  const pb = playbooks.find((p) => p.id === id) ?? playbooks[0] ?? null;
  const initial = pb ? playbookToInput(pb) : defaultPlaybookInput(ctx.org);
  const tz = ctx.org.timezone;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Playbook"
        actions={pb && !pb.approved_at && (
          <form action={approvePlaybookAction}>
            <input type="hidden" name="playbook_id" value={pb.id} />
            <Button type="submit">Approve v{pb.version}</Button>
          </form>
        )}
      >
        {pb ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {pb.name} · version {pb.version}
            {pb.approved_at
              ? <Badge tone="green" data-testid="approval-state">Approved {fmtTime(pb.approved_at, tz)}{pb.approver ? ` by ${pb.approver}` : ""}</Badge>
              : <Badge tone="yellow" data-testid="approval-state">Needs approval</Badge>}
          </span>
        ) : "No playbook yet. Fill this in, or draft one from your website in the setup wizard."}
      </PageHeader>

      {pb && !pb.approved_at && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm">
          The agent is already using this version. Approving records that you've reviewed it; an approved playbook is required to go live.
        </p>
      )}

      {playbooks.length > 1 && (
        <div className="flex flex-wrap gap-2 text-sm">
          {playbooks.map((p) => (
            <Link key={p.id} href={`/settings/playbook?id=${p.id}`} className={`rounded-full border border-app px-3 py-1 ${p.id === pb?.id ? "bg-brand/10 font-medium text-brand" : ""}`}>
              {p.name} v{p.version}{p.approved_at ? "" : " (unapproved)"}
            </Link>
          ))}
        </div>
      )}

      {!pb && (
        <p className="text-sm">
          Tip: <Link href="/onboarding?step=playbook" className="underline">draft a playbook from your website</Link>.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <PlaybookEditor
          key={pb ? `${pb.id}:${pb.version}` : "new"}
          playbookId={pb?.id ?? null}
          initial={initial}
          defaults={{ no_reply: DEFAULT_NO_REPLY, went_quiet: DEFAULT_WENT_QUIET }}
          orgSendSundays={ctx.org.send_sundays}
          saveAction={savePlaybookAction}
        />
        <div className="lg:sticky lg:top-4 lg:self-start">
          <TestChat playbookId={pb?.id ?? null} approveBeforeSend={pb?.approve_before_send ?? true} />
        </div>
      </div>
    </div>
  );
}
