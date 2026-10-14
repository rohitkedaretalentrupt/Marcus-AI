import type { z } from "zod";

import { ValidationError, type FieldIssue } from "@/lib/errors/app-error";

export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/** Parses untrusted data, throwing a `ValidationError` (HTTP 400) on failure. */
export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(toFieldIssues(result.error));
  }
  return result.data;
}
