"use client";
// Test chat beside the playbook editor: you play the lead, the agent answers using the last saved
// playbook version. Shows the structured output and guard results. Nothing is sent or stored.
import { useState } from "react";

interface Turn { from: "lead" | "ai"; body: string; meta?: Meta }
interface Meta {
  action: string;
  intent: string;
  warm: boolean;
  confidence: number;
  summary: string;
  handoff_reason: string | null;
  stage_suggestion: string | null;
  extracted: Array<{ field: string; value: string }>;
  book_slot_id: string | null;
  guard: { ok: boolean; failures: string[]; handoff: boolean; details: Record<string, unknown> };
  model: string;
}

export function TestChat({ playbookId, approveBeforeSend }: { playbookId: string | null; approveBeforeSend: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(next: Turn[]) {
    if (!playbookId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/test-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbook_id: playbookId, channel, messages: next.filter((t) => t.body).map(({ from, body }) => ({ from, body })) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const o = data.output;
      setTurns([...next, {
        from: "ai",
        body: o.message?.body ?? "",
        meta: { ...o, guard: data.guard, model: data.model },
      }]);
    } catch (e) {
      setError((e as Error).message);
      setTurns(next);
    } finally {
      setBusy(false);
    }
  }

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    const next = [...turns, { from: "lead" as const, body }];
    setTurns(next);
    void run(next);
  };

  if (!playbookId) return <div className="card p-4 text-sm muted">Save the playbook once to try it in the test chat.</div>;

  return (
    <div className="card flex flex-col p-3" data-testid="test-chat">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Test chat</h2>
        <div className="flex items-center gap-2 text-xs">
          <select value={channel} onChange={(e) => setChannel(e.target.value as "sms" | "email")} className="rounded border border-app bg-transparent px-1 py-0.5" aria-label="Channel">
            <option value="sms">Text</option>
            <option value="email">Email</option>
          </select>
          <button type="button" className="underline" onClick={() => { setTurns([]); setError(null); }}>Reset</button>
        </div>
      </div>
      <p className="mb-2 text-xs muted">You're the lead. Uses the last saved version; nothing is sent or saved.{approveBeforeSend ? " (Approve-before-send is on: real replies would wait in the inbox.)" : ""}</p>
      <ol className="mb-2 max-h-[28rem] min-h-40 space-y-2 overflow-y-auto">
        {turns.length === 0 && (
          <li className="text-center text-xs muted">
            <button type="button" className="underline" onClick={() => run([])} disabled={busy}>Generate the first message</button> or type as the lead below.
          </li>
        )}
        {turns.map((t, i) => (
          <li key={i} className={t.from === "lead" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${t.from === "lead" ? "bg-brand text-brand-fg" : t.meta && !t.meta.guard.ok ? "border border-red-500/50 bg-red-500/5" : "bg-black/5 dark:bg-white/10"}`}>
              {t.body ? <div className="whitespace-pre-wrap">{t.body}</div> : t.meta && <div className="italic muted">(no message)</div>}
              {t.meta && <MetaLine m={t.meta} />}
            </div>
          </li>
        ))}
        {busy && <li className="text-xs muted">Thinking…</li>}
      </ol>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write as the lead…" className="w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm" aria-label="Lead message" />
        <button type="submit" disabled={busy || !text.trim()} className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg disabled:opacity-50">Send</button>
      </form>
    </div>
  );
}

function MetaLine({ m }: { m: Meta }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer muted">
        {m.action}{m.action === "handoff" && m.handoff_reason ? `: ${m.handoff_reason}` : ""} · {m.intent}
        {m.guard.ok ? " · guards passed" : ` · BLOCKED: ${m.guard.failures.join(", ")}`}
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="muted">warm</dt><dd>{m.warm ? "yes" : "no"}</dd>
        <dt className="muted">confidence</dt><dd>{m.confidence.toFixed(2)}</dd>
        {m.stage_suggestion && <><dt className="muted">stage</dt><dd>{m.stage_suggestion}</dd></>}
        {m.book_slot_id && <><dt className="muted">book</dt><dd>{m.book_slot_id}</dd></>}
        {m.extracted.length > 0 && <><dt className="muted">learned</dt><dd>{m.extracted.map((e) => `${e.field}=${e.value}`).join(", ")}</dd></>}
        <dt className="muted">summary</dt><dd className="whitespace-pre-wrap">{m.summary}</dd>
        {!m.guard.ok && <><dt className="muted">guard</dt><dd>{JSON.stringify(m.guard.details)}{m.guard.handoff ? " → would hand off" : " → would not send"}</dd></>}
        <dt className="muted">model</dt><dd>{m.model}</dd>
      </dl>
    </details>
  );
}
