"use client";
import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "../../../_components/ui";

/** A submit button that disables itself and shows `pendingLabel` while its form's action runs. */
export function SubmitButton({ children, pendingLabel, disabled, ...p }: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending} {...p}>
      {pending ? pendingLabel ?? "Working…" : children}
    </Button>
  );
}
