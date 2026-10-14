"use client";
// A <form> bound to a server action that returns { ok, message?, error?, secret? }. Shows the result
// inline (errors in red, a one-time secret in a copy box) and disables the submit button while saving.
import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export interface ActionResult { ok: boolean; message?: string; error?: string; secret?: string }
export type FormAction = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

export function SubmitButton({ children, variant = "primary", className = "", name, value }: { children: ReactNode; variant?: "primary" | "secondary" | "danger"; className?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  const v = variant === "primary" ? "bg-brand text-brand-fg hover:opacity-90" : variant === "danger" ? "bg-red-600 text-white hover:bg-red-700" : "card hover:opacity-80";
  return (
    <button type="submit" name={name} value={value} disabled={pending} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${v} ${className}`}>
      {pending ? "Saving…" : children}
    </button>
  );
}

export function ActionForm({ action, children, className }: { action: FormAction; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <ResultLine state={state} />
    </form>
  );
}

export function ResultLine({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <div className="mt-2 space-y-1 text-sm" role="status">
      {state.error && <p className="text-red-600">{state.error}</p>}
      {state.ok && state.message && <p className="text-green-700 dark:text-green-400">{state.message}</p>}
      {state.secret && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
          <div className="text-xs font-medium">Copy this secret now. It won't be shown again.</div>
          <code className="block break-all text-xs" data-testid="one-time-secret">{state.secret}</code>
        </div>
      )}
    </div>
  );
}
