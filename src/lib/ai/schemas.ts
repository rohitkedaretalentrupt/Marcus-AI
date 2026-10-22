import { z } from "zod";

import { resumeContentSchema } from "@/lib/documents";
import { editActionSchema } from "@/lib/formatting/edits";

/**
 * Schemas for structured model output. Model responses are untrusted input:
 * always parse them through these before use.
 */

export const resumeAnalysisSchema = z.object({
  /** The resume parsed into canonical structure. */
  resume: resumeContentSchema,
  /** Problems the user may want to fix (missing dates, inconsistent tense, ...). */
  warnings: z.array(z.string().trim().max(500)).max(50).default([]),
});

export const RESUME_TASK_INTENTS = [
  "format_resume",
  "analyze_resume",
  "answer_question",
  "clarify",
] as const;

export const resumeTaskOutputSchema = z.object({
  intent: z.enum(RESUME_TASK_INTENTS),
  /** Template the user referred to, if any (must match an available template name). */
  templateName: z.string().trim().max(200).optional(),
  /** Message to show the user (plain text). */
  reply: z.string().trim().min(1).max(8000),
});

export const chatIntentSchema = z.object({
  format: z.boolean(),
  edits: z.array(editActionSchema).max(12).default([]),
  unmatchedSections: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  templates: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  unmatched: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
});

export type ResumeAnalysis = z.infer<typeof resumeAnalysisSchema>;
export type ResumeTaskIntent = (typeof RESUME_TASK_INTENTS)[number];
export type ResumeTaskOutput = z.infer<typeof resumeTaskOutputSchema>;
