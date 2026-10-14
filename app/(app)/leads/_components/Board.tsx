"use client";
// Pipeline board. Native HTML5 drag and drop between stage columns; each card also has a stage
// select so it works on touch devices. Both call moveStageAction (stage event + CAPI/CRM jobs).
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LeadStage } from "@/lib/db/types";
import { moveStageAction } from "../../../_actions/leads";
import { Badge, STAGE_TONE, cx, stageLabel } from "../../../_components/ui";

export interface BoardCard {
  id: string;
  name: string;
  stage: LeadStage;
  sub: string;
  rep: string;
  ai: string;
  warm: boolean;
  age: string;
}

export function Board({ stages, cards: initial }: { stages: LeadStage[]; cards: BoardCard[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initial);
  const [over, setOver] = useState<LeadStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setCards(initial), [initial]);

  const move = (id: string, stage: LeadStage) => {
    const card = cards.find((c) => c.id === id);
    if (!card || card.stage === stage) return;
    const before = cards;
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage } : c)));
    setError(null);
    start(async () => {
      try {
        await moveStageAction(id, stage);
        router.refresh();
      } catch (e) {
        setCards(before);
        setError(e instanceof Error ? e.message : "Could not move the lead");
      }
    });
  };

  return (
    <div>
      {error && <div className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</div>}
      <div className={cx("-mx-4 flex gap-3 overflow-x-auto px-4 pb-4", pending && "opacity-80")}>
        {stages.map((stage) => {
          const col = cards.filter((c) => c.stage === stage);
          return (
            <section
              key={stage}
              data-testid={`board-column-${stage}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(stage); }}
              onDragLeave={() => setOver((s) => (s === stage ? null : s))}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) move(id, stage); }}
              className={cx("flex w-64 shrink-0 flex-col rounded-xl border border-app p-2", over === stage ? "bg-brand/10" : "bg-black/[0.02] dark:bg-white/[0.03]")}
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <Badge tone={STAGE_TONE[stage]}>{stageLabel(stage)}</Badge>
                <span className="text-xs muted tabular-nums">{col.length}</span>
              </header>
              <ul className="min-h-16 space-y-2">
                {col.map((c) => (
                  <li
                    key={c.id}
                    data-testid="lead-card"
                    data-lead-id={c.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; }}
                    className="card cursor-grab p-2.5 text-sm active:cursor-grabbing"
                  >
                    <Link href={`/leads/${c.id}`} className="block" draggable={false}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{c.name}</span>
                        {c.warm && <Badge tone="yellow">Warm</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-xs muted">{c.sub}</div>
                      <div className="mt-1 flex items-center justify-between text-xs muted">
                        <span className="truncate">{c.rep}</span>
                        <span>{c.age}</span>
                      </div>
                      {c.ai !== "active" && <div className="mt-1"><Badge tone={c.ai === "paused" ? "yellow" : "red"}>AI {c.ai}</Badge></div>}
                    </Link>
                    <label className="mt-2 block">
                      <span className="sr-only">Move {c.name} to stage</span>
                      <select
                        aria-label={`Stage for ${c.name}`}
                        data-testid="card-stage-select"
                        value={c.stage}
                        onChange={(e) => move(c.id, e.target.value as LeadStage)}
                        className="w-full rounded-md border border-app bg-transparent px-2 py-1 text-xs"
                      >
                        {stages.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
