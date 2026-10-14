import { z } from "zod";

import { fileIdSchema } from "@/lib/files/validation";
import { idSchema } from "@/lib/validation/common";

import type { ClientTemplateStructure } from "./structure";

export const TEMPLATE_STATUSES = ["PROCESSING", "READY", "FAILED"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_FAILURES = {
  no_text:
    "This template doesn't contain selectable text (it may be a scanned image). Scanned templates aren't supported yet.",
  unreadable: "This template couldn't be read. It may be damaged or password-protected.",
  storage_error: "The template file couldn't be retrieved. Please try again.",
  ai_unavailable: "The template couldn't be analysed right now. Please try again.",
  ai_not_configured:
    "Saved. It will be analysed once the AI service is configured — then tap Retry. No need to upload it again.",
  ai_invalid: "The template analysis returned an unexpected result. Please try again.",
  internal: "Something went wrong while analysing this template. Please try again.",
} as const;
export type TemplateFailureCode = keyof typeof TEMPLATE_FAILURES;

export const TEMPLATE_NAME_MAX = 100;

export const templateNameSchema = z
  .string({ error: "Enter a template name." })
  .trim()
  .min(1, "Enter a template name.")
  .max(TEMPLATE_NAME_MAX, `Template names can be at most ${TEMPLATE_NAME_MAX} characters.`);

export const createTemplateSchema = z.strictObject({
  name: templateNameSchema,
  fileId: fileIdSchema,
});

export const templateIdSchema = idSchema;

/** `null` clears the selection. */
export const selectTemplateSchema = z.strictObject({
  templateId: templateIdSchema.nullable(),
});

/** List item (no structure). Never includes storage keys. */
export interface TemplateSummary {
  id: string;
  name: string;
  status: TemplateStatus;
  filename: string;
  mimeType: string;
  failureMessage: string | null;
  /** Saved, but analysis is waiting for the AI provider to be configured. */
  awaitingAI: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface TemplateDetail extends TemplateSummary {
  structure: ClientTemplateStructure | null;
  analyzedBy: string | null;
}
