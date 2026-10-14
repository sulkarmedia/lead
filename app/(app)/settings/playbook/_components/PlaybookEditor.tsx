"use client";
// Playbook editor. Keeps the whole playbook in local state and submits it as JSON; the server
// validates it with the same zod schema the generator uses (lib/playbook-generator.ts PlaybookInput).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PlaybookInput } from "@/lib/playbook-generator";
import type { CadenceStep } from "@/lib/db/types";
import { ActionForm, SubmitButton, type FormAction } from "../../_components/ActionForm";

const input = "w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/40";
const GOALS = ["appointment", "call", "quote", "reservation"] as const;
const KINDS = [["in_person", "In person"], ["call", "Phone call"], ["video", "Video"]] as const;

interface FieldRow { key: string; label: string; optionsText: string; required: boolean; description: string }
interface State extends Omit<PlaybookInput, "handoff_triggers" | "never_say" | "qualification_fields"> {
  handoffText: string;
  neverSayText: string;
  fields: FieldRow[];
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const toState = (p: PlaybookInput): State => {
  const { handoff_triggers, never_say, qualification_fields, ...rest } = p;
  return {
    ...rest,
    handoffText: handoff_triggers.join("\n"),
    neverSayText: never_say.join("\n"),
    fields: qualification_fields.map((f) => ({ key: f.key, label: f.label, optionsText: f.options.join(", "), required: f.required, description: f.description ?? "" })),
  };
};
export function toInput(s: State): PlaybookInput {
  const { handoffText, neverSayText, fields, ...rest } = s;
  return {
    ...rest,
    goal_detail: rest.goal_detail?.trim() || null,
    warm_rule: rest.warm_rule?.trim() || null,
    tone: rest.tone?.trim() || null,
    handoff_triggers: lines(handoffText),
    never_say: lines(neverSayText),
    qualification_fields: fields.map((f) => ({
      key: f.key.trim(), label: f.label.trim(), options: f.optionsText.split(",").map((o) => o.trim()).filter(Boolean), required: f.required, description: f.description.trim() || null,
    })),
  };
}

const clamp = (start: string, end: string) => ({ start: start < "08:00" ? "08:00" : start, end: end > "21:00" ? "21:00" : end });

export function PlaybookEditor({ playbookId, initial, defaults, orgSendSundays, saveAction, onChange, submitSlot }: {
  playbookId: string | null;
  initial: PlaybookInput;
  defaults: { no_reply: CadenceStep[]; went_quiet: CadenceStep[] };
  orgSendSundays: boolean;
  saveAction: FormAction;
  onChange?: (p: PlaybookInput) => void;
  /** Replaces the default "Save new version" button (the wizard uses Save / Save and approve). */
  submitSlot?: ReactNode;
}) {
  const [s, setS] = useState<State>(() => toState(initial));
  const set = (patch: Partial<State>) => setS((prev) => ({ ...prev, ...patch }));
  const json = useMemo(() => JSON.stringify(toInput(s)), [s]);
  useEffect(() => {
    onChange?.(toInput(s));
  }, [s, onChange]);
  const eff = clamp(s.send_window.start, s.send_window.end);
  const clamped = eff.start !== s.send_window.start || eff.end !== s.send_window.end;
  const custom = s.cadence !== "default";

  const setField = (i: number, patch: Partial<FieldRow>) => set({ fields: s.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setStep = (kind: "no_reply" | "went_quiet", i: number, patch: Partial<CadenceStep>) => {
    if (s.cadence === "default") return;
    set({ cadence: { ...s.cadence, [kind]: s.cadence[kind].map((st, j) => (j === i ? { ...st, ...patch } : st)) } });
  };

  return (
    <ActionForm action={saveAction} className="space-y-4">
      <input type="hidden" name="playbook_id" value={playbookId ?? ""} />
      <input type="hidden" name="playbook_json" value={json} />

      <Section title="Goal">
        <div className="grid gap-3 sm:grid-cols-2">
          <L label="Playbook name"><input className={input} value={s.name} onChange={(e) => set({ name: e.target.value })} required /></L>
          <L label="Goal">
            <select className={input} value={s.goal} onChange={(e) => set({ goal: e.target.value as State["goal"] })}>
              {GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </L>
        </div>
        <L label="Goal detail" hint="What a successful conversation ends with.">
          <input className={input} value={s.goal_detail ?? ""} onChange={(e) => set({ goal_detail: e.target.value })} />
        </L>
      </Section>

      <Section title="Qualification fields" hint="What the assistant learns in conversation. Keys are used in the warm rule.">
        <div className="space-y-2">
          {s.fields.map((f, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-app p-2 sm:grid-cols-[8rem_1fr_1fr_auto]">
              <input className={input} placeholder="key" value={f.key} onChange={(e) => setField(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} aria-label="Field key" />
              <input className={input} placeholder="Label" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} aria-label="Field label" />
              <input className={input} placeholder="Options, comma separated (optional)" value={f.optionsText} onChange={(e) => setField(i, { optionsText: e.target.value })} aria-label="Options" />
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> required</label>
                <button type="button" className="text-xs text-red-600" onClick={() => set({ fields: s.fields.filter((_, j) => j !== i) })}>Remove</button>
              </div>
              <input className={`${input} sm:col-span-4`} placeholder="Description for the assistant (optional)" value={f.description} onChange={(e) => setField(i, { description: e.target.value })} aria-label="Description" />
            </div>
          ))}
          <button type="button" className="text-sm underline" onClick={() => set({ fields: [...s.fields, { key: "", label: "", optionsText: "", required: false, description: "" }] })}>+ Add field</button>
        </div>
        <L label="Warm rule" hint="e.g. model_interest AND timeline within 90 days">
          <input className={input} value={s.warm_rule ?? ""} onChange={(e) => set({ warm_rule: e.target.value })} />
        </L>
      </Section>

      <Section title="Handoff and tone">
        <L label="Handoff triggers" hint="One per line. A person takes over when any of these happens.">
          <textarea className={`${input} min-h-24`} value={s.handoffText} onChange={(e) => set({ handoffText: e.target.value })} />
        </L>
        <L label="Tone"><textarea className={`${input} min-h-16`} value={s.tone ?? ""} onChange={(e) => set({ tone: e.target.value })} /></L>
        <L label="Never say" hint="One phrase per line. A message containing any of them is blocked.">
          <textarea className={`${input} min-h-20`} value={s.neverSayText} onChange={(e) => set({ neverSayText: e.target.value })} />
        </L>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.bridge_message_allowed} onChange={(e) => set({ bridge_message_allowed: e.target.checked })} /> Send a short bridge message on handoff</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.approve_before_send} onChange={(e) => set({ approve_before_send: e.target.checked })} /> Approve every AI message before it sends</label>
        </div>
      </Section>

      <Section title="First message" hint="Sent as-is if the AI is slow to answer a new lead. Must name the business, say it's the virtual assistant and include “Reply STOP to opt out.” Variables: {first_name}, {business_name}, any field key.">
        <textarea className={`${input} min-h-20`} value={s.intro_template} onChange={(e) => set({ intro_template: e.target.value })} maxLength={320} />
        <div className={`text-xs ${s.intro_template.length > 300 ? "text-red-600" : "muted"}`}>{s.intro_template.length}/320</div>
      </Section>

      <Section title="Follow-up cadence">
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={!custom} onChange={() => set({ cadence: "default" })} /> Default cadence</label>
          <label className="flex items-center gap-2"><input type="radio" checked={custom} onChange={() => set({ cadence: s.cadence === "default" ? { no_reply: defaults.no_reply, went_quiet: defaults.went_quiet } : s.cadence })} /> Custom steps</label>
        </div>
        {s.cadence === "default" ? (
          <ul className="text-xs muted">
            {defaults.no_reply.map((st, i) => <li key={i}>No reply · after {st.after} · {st.channel} · {st.angle}</li>)}
          </ul>
        ) : (
          (["no_reply", "went_quiet"] as const).map((kind) => (
            <div key={kind} className="space-y-2">
              <div className="text-xs font-medium">{kind === "no_reply" ? "Never replied (from lead creation)" : "Went quiet (from their last message)"}</div>
              {(s.cadence as Exclude<State["cadence"], "default">)[kind].map((st, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[5rem_7rem_1fr_auto]">
                  <input className={input} value={st.after} onChange={(e) => setStep(kind, i, { after: e.target.value })} aria-label="After" placeholder="2h" />
                  <select className={input} value={st.channel} onChange={(e) => setStep(kind, i, { channel: e.target.value as CadenceStep["channel"] })} aria-label="Channel">
                    <option value="sms">Text</option><option value="email">Email</option><option value="both">Both</option>
                  </select>
                  <input className={input} value={st.angle} onChange={(e) => setStep(kind, i, { angle: e.target.value })} aria-label="Angle" placeholder="Angle" />
                  <button type="button" className="text-xs text-red-600" onClick={() => s.cadence !== "default" && set({ cadence: { ...s.cadence, [kind]: s.cadence[kind].filter((_, j) => j !== i) } })}>Remove</button>
                </div>
              ))}
              <button type="button" className="text-sm underline" onClick={() => s.cadence !== "default" && set({ cadence: { ...s.cadence, [kind]: [...s.cadence[kind], { after: "1d", channel: "sms", angle: "" }] } })}>+ Add step</button>
            </div>
          ))
        )}
        <L label="Max automated touches per lead"><input type="number" min={1} max={30} className={`${input} w-28`} value={s.max_touches} onChange={(e) => set({ max_touches: Number(e.target.value) })} /></L>
        <p className="text-xs muted">The compliance cap (3 automated messages per lead per 24 hours) always applies on top of this.</p>
      </Section>

      <Section title="Send window">
        <div className="flex flex-wrap items-end gap-3">
          <L label="Start"><input type="time" className={input} value={s.send_window.start} onChange={(e) => set({ send_window: { ...s.send_window, start: e.target.value } })} /></L>
          <L label="End"><input type="time" className={input} value={s.send_window.end} onChange={(e) => set({ send_window: { ...s.send_window, end: e.target.value } })} /></L>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={s.send_window.sundays} onChange={(e) => set({ send_window: { ...s.send_window, sundays: e.target.checked } })} /> Sundays</label>
        </div>
        <p className={`text-xs ${clamped ? "text-amber-700 dark:text-amber-300" : "muted"}`}>
          Automated messages go out between {eff.start} and {eff.end} in the lead's local time{clamped ? " (clamped to the legal 08:00–21:00 limit)" : ""}. Stricter state rules apply on top.
          {s.send_window.sundays && !orgSendSundays ? " Sundays are off for the whole business (Hours settings)." : ""}
        </p>
      </Section>

      <Section title="Booking">
        <div className="flex flex-wrap gap-4 text-sm">
          {KINDS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={s.booking.kinds.includes(k)} onChange={(e) => set({ booking: { ...s.booking, kinds: e.target.checked ? [...s.booking.kinds, k] : s.booking.kinds.filter((x) => x !== k) } })} /> {label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <L label="Slot length (min)"><input type="number" min={10} max={240} className={input} value={s.booking.slot_minutes} onChange={(e) => set({ booking: { ...s.booking, slot_minutes: Number(e.target.value) } })} /></L>
          <L label="Minimum notice (min)"><input type="number" min={0} max={10080} className={input} value={s.booking.min_notice_minutes} onChange={(e) => set({ booking: { ...s.booking, min_notice_minutes: Number(e.target.value) } })} /></L>
          <L label="Days ahead"><input type="number" min={1} max={60} className={input} value={s.booking.days_ahead} onChange={(e) => set({ booking: { ...s.booking, days_ahead: Number(e.target.value) } })} /></L>
        </div>
      </Section>

      <div className="sticky bottom-16 z-10 flex items-center gap-3 rounded-lg bg-[var(--card)] py-2 md:bottom-0">
        {submitSlot ?? (
          <>
            <SubmitButton>Save new version</SubmitButton>
            <span className="text-xs muted">Saving creates a new version that needs approval.</span>
          </>
        )}
      </div>
    </ActionForm>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="text-xs muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      {children}
      {hint && <span className="block text-xs muted">{hint}</span>}
    </label>
  );
}
