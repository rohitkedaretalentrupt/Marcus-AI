import type { z } from "zod";

import type { FieldIssue } from "@/lib/errors/app-error";

export type FieldErrors = Partial<Record<string, string>>;

/** First message per top-level field, for inline display. */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Same shape for `issues` returned by our API (`ValidationError`). */
export function apiFieldErrors(issues: FieldIssue[] | undefined): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues ?? []) {
    const field = issue.path.split(".")[0] ?? "";
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Moves focus to the first invalid field so keyboard/screen-reader users land on it. */
export function focusFirstInvalid(form: HTMLFormElement, errors: FieldErrors, order: string[]) {
  const first = order.find((name) => errors[name]);
  if (!first) return;
  const element = form.elements.namedItem(first);
  if (element instanceof HTMLElement) element.focus();
}
