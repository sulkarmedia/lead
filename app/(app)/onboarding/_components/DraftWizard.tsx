"use client";
// Wizard step 8: website URL → generator (fetch, Haiku extraction, Sonnet draft) → the owner edits
// the playbook and picks knowledge items → Save, or Save and approve. Nothing is saved before that.
import { useState } from "react";
import type { CadenceStep } from "@/lib/db/types";
import type { KnowledgeDraft, PlaybookDraft } from "@/lib/playbook-generator";
import { PlaybookEditor } from "../../settings/playbook/_components/PlaybookEditor";
import { SubmitButton, type ActionResult, type FormAction } from "../../settings/_components/ActionForm";

type Draft = PlaybookDraft & { pages: Array<{ url: string; title: string }> };
type GenResult = { ok: true; draft: Draft } | { ok: false; error: string };
const KINDS = ["service", "faq", "policy", "offer", "inventory", "location"] as const;
const input = "w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm";

export function DraftWizard({ websiteUrl, defaults, orgSendSundays, generate, save }: {
  websiteUrl: string | null;
  defaults: { no_reply: CadenceStep[]; went_quiet: CadenceStep[] };
  orgSendSundays: boolean;
  generate: (url: string) => Promise<GenResult>;
  save: (input: { playbook: unknown; knowledge_items: unknown; approve: boolean }) => Promise<ActionResult>;
}) {
  const [url, setUrl] = useState(websiteUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [items, setItems] = useState<Array<KnowledgeDraft & { keep: boolean }>>([]);
  const [gen, setGen] = useState(0);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await generate(url).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDraft(r.draft);
    setItems(r.draft.knowledge_items.map((k) => ({ ...k, keep: true })));
    setGen((g) => g + 1);
  }

  const onSave: FormAction = async (_prev, form) => {
    let playbook: unknown;
    try { playbook = JSON.parse(String(form.get("playbook_json"))); } catch { return { ok: false, error: "Invalid playbook" }; }
    return save({ playbook, knowledge_items: items.filter((i) => i.keep).map(({ keep: _k, ...k }) => k), approve: form.get("approve") === "1" });
  };
  const patch = (i: number, p: Partial<KnowledgeDraft & { keep: boolean }>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbusiness.com" aria-label="Website URL" />
        <button type="button" onClick={run} disabled={busy || !url.trim()} className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg disabled:opacity-50">
          {busy ? "Reading your site… (1–3 min)" : draft ? "Draft again" : "Draft my playbook"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {draft && (
        <>
          <div className="rounded-lg bg-black/5 p-3 text-sm dark:bg-white/10">
            Read {draft.pages.length} page{draft.pages.length === 1 ? "" : "s"}: {draft.pages.map((p) => p.title || p.url).join(" · ")}
            {draft.warnings.map((w, i) => <p key={i} className="mt-1 text-amber-700 dark:text-amber-300">{w}</p>)}
          </div>

          <section className="card space-y-2 p-4">
            <h2 className="text-sm font-semibold">Knowledge items ({items.filter((i) => i.keep).length} selected)</h2>
            <p className="text-xs muted">Check each fact, especially prices and offers. The assistant can only quote what's kept here.</p>
            {items.length === 0 && <p className="text-sm muted">No facts found. Add knowledge items later in Settings.</p>}
            {items.map((k, i) => (
              <div key={i} className={`space-y-2 rounded-lg border border-app p-2 ${k.keep ? "" : "opacity-50"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={k.keep} onChange={(e) => patch(i, { keep: e.target.checked })} /> Keep</label>
                  <select className="rounded border border-app bg-transparent px-1 py-0.5 text-xs" value={k.kind} onChange={(e) => patch(i, { kind: e.target.value as KnowledgeDraft["kind"] })} aria-label="Kind">
                    {KINDS.map((x) => <option key={x}>{x}</option>)}
                  </select>
                  {k.source_url && <span className="truncate text-xs muted">{k.source_url}</span>}
                </div>
                <input className={input} value={k.title} onChange={(e) => patch(i, { title: e.target.value })} aria-label="Title" />
                <textarea className={`${input} min-h-16`} value={k.body} onChange={(e) => patch(i, { body: e.target.value })} aria-label="Body" />
              </div>
            ))}
          </section>

          <PlaybookEditor
            key={gen}
            playbookId={null}
            initial={draft.playbook}
            defaults={defaults}
            orgSendSundays={orgSendSundays}
            saveAction={onSave}
            submitSlot={
              <>
                <SubmitButton name="approve" value="1">Save and approve</SubmitButton>
                <SubmitButton name="approve" value="0" variant="secondary">Save without approving</SubmitButton>
              </>
            }
          />
        </>
      )}
    </div>
  );
}
