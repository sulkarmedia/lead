// /settings/knowledge: the facts the agent may state (CRUD), re-scan the website for new items
// (proposed for approval, never auto-saved) and the inventory feed URL.
import { requireAdmin } from "@/lib/auth";
import { q, withUserDb } from "@/lib/db";
import type { KnowledgeItem } from "@/lib/db/types";
import { Badge, Button, Card, CardTitle, Empty, Input, Label, PageHeader, Select, Textarea } from "../../../_components/ui";
import { addKnowledgeDraftsAction, deleteKnowledgeAction, rescanWebsiteAction, saveInventoryFeedAction, saveKnowledgeAction, toggleKnowledgeAction } from "../../../_actions/settings";
import { ActionForm, SubmitButton } from "../_components/ActionForm";
import { Rescan } from "./_components/Rescan";

export const dynamic = "force-dynamic";

const KINDS = ["service", "faq", "policy", "offer", "inventory", "location"];

export default async function KnowledgeSettings() {
  const ctx = await requireAdmin();
  const items = await withUserDb(ctx.user.id, (c) =>
    q<KnowledgeItem>(c, "select * from knowledge_items where org_id = $1 order by active desc, kind, title", [ctx.org.id]));
  const feed = (ctx.org.onboarding_progress?.inventory_feed_url as string | undefined) ?? "";
  const activeCount = items.filter((i) => i.active).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge">
        The only facts the assistant may state. Any price, rate or offer it mentions must appear here word for word. {activeCount} active.
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Re-scan website</CardTitle>
          <Rescan websiteUrl={ctx.org.website_url} scan={rescanWebsiteAction} add={addKnowledgeDraftsAction} />
        </Card>
        <Card>
          <CardTitle>Inventory feed</CardTitle>
          <ActionForm action={saveInventoryFeedAction} className="space-y-2">
            <Label hint="CSV or XML feed URL from your website provider. Synced nightly into inventory items.">
              Feed URL
              <Input name="inventory_feed_url" type="url" defaultValue={feed} placeholder="https://…/inventory.xml" />
            </Label>
            <SubmitButton>Save feed</SubmitButton>
          </ActionForm>
        </Card>
      </div>

      <Card>
        <CardTitle>Add an item</CardTitle>
        <ItemForm />
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Items</h2>
        {items.length === 0 ? <Empty>No knowledge items yet. Re-scan your website or add one above.</Empty> : (
          <ul className="space-y-2">
            {items.map((k) => (
              <li key={k.id} className={`card p-3 ${k.active ? "" : "opacity-60"}`}>
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <Badge tone="blue">{k.kind}</Badge>
                    <span className="font-medium">{k.title}</span>
                    {!k.active && <Badge>inactive</Badge>}
                    <span className="w-full truncate text-xs muted">{k.body.slice(0, 140)}</span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <ItemForm item={k} />
                    <div className="flex gap-2">
                      <form action={toggleKnowledgeAction}>
                        <input type="hidden" name="id" value={k.id} />
                        <Button variant="secondary" type="submit">{k.active ? "Deactivate" : "Activate"}</Button>
                      </form>
                      <form action={deleteKnowledgeAction}>
                        <input type="hidden" name="id" value={k.id} />
                        <Button variant="danger" type="submit">Delete</Button>
                      </form>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ItemForm({ item }: { item?: KnowledgeItem }) {
  return (
    <ActionForm action={saveKnowledgeAction} className="space-y-2">
      {item && <input type="hidden" name="id" value={item.id} />}
      {item && <input type="hidden" name="active" value={item.active ? "true" : "false"} />}
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Label>Kind
          <Select name="kind" defaultValue={item?.kind ?? "faq"}>{KINDS.map((k) => <option key={k}>{k}</option>)}</Select>
        </Label>
        <Label>Title<Input name="title" defaultValue={item?.title ?? ""} required maxLength={200} /></Label>
      </div>
      <Label>Body<Textarea name="body" defaultValue={item?.body ?? ""} required maxLength={5000} className="min-h-28" /></Label>
      <Label>Source URL (optional)<Input name="source_url" type="url" defaultValue={item?.source_url ?? ""} /></Label>
      <SubmitButton>{item ? "Save" : "Add item"}</SubmitButton>
    </ActionForm>
  );
}
