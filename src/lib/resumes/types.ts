import type { ResumeContent } from "@/lib/documents/resume-content";

export const EXTRACTION_STATUSES = ["PROCESSING", "READY", "FAILED"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_FAILURES = {
  no_text:
    "This file doesn't contain selectable text (it may be a scanned image). Scanned resumes aren't supported yet.",
  unreadable: "This file couldn't be read. It may be damaged or password-protected.",
  storage_error: "The file couldn't be retrieved. Please try again.",
  internal: "Something went wrong while reading this file. Please try again.",
} as const;
export type ExtractionFailureCode = keyof typeof EXTRACTION_FAILURES;

/** Safe, owner-only view of an extraction (no storage key, no raw text). */
export interface ResumeExtractionView {
  fileId: string;
  status: ExtractionStatus;
  parserVersion: number;
  content: ResumeContent | null;
  warnings: string[];
  failureMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}
