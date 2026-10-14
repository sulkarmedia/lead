"use client";
// "Re-scan website": runs the generator's fetch + extraction and shows proposed knowledge items.
// The owner edits/selects them; only the selected ones are saved.
import { useState } from "react";
import type { KnowledgeDraft } from "@/lib/playbook-generator";

const KINDS = ["service", "faq", "policy", "offer", "inventory", "location"] as const;
const input = "w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm";

type ScanResult = { ok: true; items: KnowledgeDraft[]; pages: number; warning: string | null } | { ok: false; error: string };

export function Rescan({ websiteUrl, scan, add }: {
  websiteUrl: string | null;
  scan: (url: string) => Promise<ScanResult>;
  add: (items: KnowledgeDraft[]) => Promise<{ ok: boolean; message?: string; error?: string }>;
}) {
  const [url, setUrl] = useState(websiteUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Array<KnowledgeDraft & { keep: boolean }>>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doScan() {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await scan(url).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setItems(r.items.map((i) => ({ ...i, keep: true })));
    setNote(`Read ${r.pages} page${r.pages === 1 ? "" : "s"}; ${r.items.length} new item${r.items.length === 1 ? "" : "s"} proposed.${r.warning ? ` ${r.warning}` : ""}`);
  }

  async function doAdd() {
    setBusy(true);
    const r = await add(items.filter((i) => i.keep).map(({ keep: _k, ...rest }) => rest));
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Failed");
    setItems([]);
    setNote(r.message ?? "Added.");
  }

  const patch = (i: number, p: Partial<KnowledgeDraft & { keep: boolean }>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbusiness.com" aria-label="Website URL" />
        <button type="button" onClick={doScan} disabled={busy} className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg disabled:opacity-50">
          {busy && !items.length ? "Scanning… (up to a minute)" : "Re-scan website"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {note && <p className="text-sm muted">{note}</p>}
      {items.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs muted">Review before adding. Check every price and offer against your site; the assistant may only quote what's here.</p>
          {items.map((k, i) => (
            <div key={i} className={`space-y-2 rounded-lg border border-app p-2 ${k.keep ? "" : "opacity-50"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={k.keep} onChange={(e) => patch(i, { keep: e.target.checked })} /> Add</label>
                <select className="rounded border border-app bg-transparent px-1 py-0.5 text-xs" value={k.kind} onChange={(e) => patch(i, { kind: e.target.value as KnowledgeDraft["kind"] })} aria-label="Kind">
                  {KINDS.map((x) => <option key={x}>{x}</option>)}
                </select>
                {k.source_url && <a href={k.source_url} target="_blank" rel="noreferrer" className="truncate text-xs underline muted">{k.source_url}</a>}
              </div>
              <input className={input} value={k.title} onChange={(e) => patch(i, { title: e.target.value })} aria-label="Title" />
              <textarea className={`${input} min-h-20`} value={k.body} onChange={(e) => patch(i, { body: e.target.value })} aria-label="Body" />
            </div>
          ))}
          <button type="button" onClick={doAdd} disabled={busy || !items.some((i) => i.keep)} className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg disabled:opacity-50">
            Add {items.filter((i) => i.keep).length} selected
          </button>
        </div>
      )}
    </div>
  );
}
