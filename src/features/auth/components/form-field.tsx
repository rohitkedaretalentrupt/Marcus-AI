"use client";

import type { ComponentProps, ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FormFieldProps = Omit<ComponentProps<"input">, "id" | "name"> & {
  name: string;
  label: string;
  error?: string;
  /** Persistent help text (e.g. password requirements), announced with the field. */
  hint?: ReactNode;
  /** Replaces the default `<Input>` (e.g. a password input with a toggle). */
  renderInput?: (props: ComponentProps<"input">) => ReactNode;
};

/** Label + input + hint + error, wired together for screen readers. */
export function FormField({
  name,
  label,
  error,
  hint,
  renderInput,
  ...inputProps
}: FormFieldProps) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const props: ComponentProps<"input"> = {
    ...inputProps,
    id,
    name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {renderInput ? renderInput(props) : <Input {...props} />}
      {hint ? (
        <div id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
