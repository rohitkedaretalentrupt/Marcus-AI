import { z } from "zod";

import { fileIdSchema } from "@/lib/files/validation";
import { idSchema } from "@/lib/validation/common";

/** Bump when plan rules or the renderer change output (stored on each job). */
export const FORMATTING_ENGINE_VERSION = 3;

export const FORMATTING_JOB_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type FormattingJobStatus = (typeof FORMATTING_JOB_STATUSES)[number];

export const FORMATTING_FAILURES = {
  resume_unavailable: "The resume is no longer available or hasn't finished processing.",
  template_unavailable: "The client template is no longer available or hasn't been analysed.",
  ai_unavailable: "The formatting service isn't available right now. Please try again.",
  ai_timeout: "Formatting took too long. Please try again.",
  ai_invalid: "The AI returned an unusable formatting plan. Please try again.",
  render_failed: "The document couldn't be generated. Please try again.",
  validation_failed:
    "The generated document didn't pass its quality checks, so it wasn't saved. Please try again.",
  storage_error: "The generated document couldn't be saved. Please try again.",
  stale: "This formatting job stopped unexpectedly. Please try again.",
  too_large:
    "This resume is too long to format automatically. Shorten it or split it into separate files.",
  internal: "Something went wrong while formatting this resume. Please try again.",
} as const;
export type FormattingFailureCode = keyof typeof FORMATTING_FAILURES;

export const createFormattingJobSchema = z.strictObject({
  resumeFileId: fileIdSchema,
  templateId: idSchema,
});

export const formattingJobIdSchema = idSchema;

/** Owner-only view of a job. Never includes storage keys, the plan or resume text. */
export interface FormattingJobView {
  id: string;
  status: FormattingJobStatus;
  resume: { fileId: string; filename: string } | null;
  template: { id: string; name: string } | null;
  failureMessage: string | null;
  warnings: string[];
  document: { filename: string; sizeBytes: number } | null;
  canRetry: boolean;
  aiModel: string | null;
  engineVersion: number;
  /** Conversation the job was started from (null for older jobs). */
  conversationId: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A resume that can be formatted (an uploaded file with a READY extraction). */
export interface FormattableResume {
  fileId: string;
  filename: string;
  candidateName: string | null;
  extractedAt: string | null;
}
