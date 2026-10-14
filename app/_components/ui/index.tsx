// Small shadcn-style primitives. Server-component friendly (no client state).
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
export { cx };

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const btn: Record<BtnVariant, string> = {
  primary: "bg-brand text-brand-fg hover:opacity-90",
  secondary: "card hover:opacity-80",
  ghost: "hover:bg-black/5 dark:hover:bg-white/10",
  danger: "bg-red-600 text-white hover:bg-red-700",
};
const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none";

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: BtnVariant }) {
  return <button className={cx(btnBase, btn[variant], className)} {...p} />;
}
export function ButtonLink({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: BtnVariant }) {
  return <Link className={cx(btnBase, btn[variant], className)} {...p} />;
}
export function Card({ className, ...p }: ComponentProps<"div">) {
  return <div className={cx("card p-4", className)} {...p} />;
}
export function CardTitle({ className, ...p }: ComponentProps<"h2">) {
  return <h2 className={cx("mb-2 text-sm font-semibold", className)} {...p} />;
}
const inputCls = "w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/40";
export function Input({ className, ...p }: ComponentProps<"input">) {
  return <input className={cx(inputCls, className)} {...p} />;
}
export function Textarea({ className, ...p }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputCls, "min-h-20", className)} {...p} />;
}
export function Select({ className, ...p }: ComponentProps<"select">) {
  return <select className={cx(inputCls, className)} {...p} />;
}
export function Label({ className, children, hint, ...p }: ComponentProps<"label"> & { hint?: ReactNode }) {
  return (
    <label className={cx("block space-y-1 text-sm", className)} {...p}>
      {children}
      {hint && <span className="block text-xs muted">{hint}</span>}
    </label>
  );
}

type Tone = "gray" | "blue" | "green" | "yellow" | "red" | "purple";
const tones: Record<Tone, string> = {
  gray: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  green: "bg-green-500/10 text-green-700 dark:text-green-300",
  yellow: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "bg-red-500/10 text-red-700 dark:text-red-300",
  purple: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
};
export function Badge({ tone = "gray", className, ...p }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)} {...p} />;
}

export const STAGE_TONE: Record<string, Tone> = {
  new: "gray", contacted: "blue", engaged: "blue", qualified: "purple", appointment_set: "yellow", showed: "green", sold: "green", nurture: "gray", lost: "red",
};
export const stageLabel = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children && <div className="text-sm muted">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card p-8 text-center text-sm muted">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs muted">{sub}</div>}
    </div>
  );
}
