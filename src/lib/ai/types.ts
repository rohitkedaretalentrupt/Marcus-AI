import type { ResumeContent } from "@/lib/documents";
import type { BlockInfo } from "@/lib/documents/docx/template-blocks";
import type { AIFillPlan } from "@/lib/formatting/fill-plan";
import type { AIFormattingPlan } from "@/lib/formatting/plan";
import type { TemplateLayoutHints } from "@/lib/templates/layout-hints";
import type { ClientTemplateStructure } from "@/lib/templates/structure";

import type { ResumeAnalysis, ResumeTaskOutput } from "./schemas";

/** Provider ids accepted by the AI_PROVIDER env var. */
export const AI_PROVIDER_IDS = ["mimo"] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Binary input for multimodal models (e.g. a photo of a resume). */
export interface AIAttachment {
  mimeType: string;
  data: Uint8Array;
}

export interface AIRequestOptions {
  signal?: AbortSignal;
  /** Correlates provider calls with an AIJob row for logging/billing. */
  jobId?: string;
}

export interface AnalyzeResumeInput {
  /** Text extracted from the uploaded resume (see DocumentTextExtractor). */
  resumeText: string;
  attachments?: AIAttachment[];
}

/**
 * Plan how a resume maps into a client template. The resume is the source of
 * truth for facts; the template controls presentation. The model answers
 * with a FormattingPlan that references content and never contains it.
 */
export interface FormatResumeInput {
  resume: ResumeContent;
  template: ClientTemplateStructure;
  /** Set for the one controlled correction request after a plan failed checks. */
  correction?: {
    previousPlan: AIFormattingPlan;
    /** Problems found (references and headings only, never resume text). */
    issues: string[];
  };
}

/**
 * Map a resume onto the addressable blocks of a DOCX client template. The
 * model answers with a FillPlan that references content and never contains it.
 */
export interface FillTemplateInput {
  resume: ResumeContent;
  blocks: BlockInfo[];
  /** Set for the one controlled correction request after a plan failed checks. */
  correction?: {
    previousPlan: AIFillPlan;
    /** Problems found (block ids and references only, never resume text). */
    issues: string[];
  };
}

/** One prior turn of the conversation, oldest first (plain text only). */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A resume the user attached, as structured data (never raw files or storage URLs). */
export interface ResumeContext {
  filename: string;
  /** Null when the file could not be read (e.g. a scan); `note` explains why. */
  content: ResumeContent | null;
  note?: string;
}

/** A free-form user request, e.g. "Make the experience section more professional". */
export interface ResumeTaskInput {
  /** The user's latest message. */
  instruction: string;
  /** Earlier turns for context (already truncated by the caller). */
  history: ChatTurn[];
  /** Resumes attached in this conversation (most recent first). */
  resumes: ResumeContext[];
  /** Names of the user's client templates, so the model can resolve references. */
  availableTemplates: string[];
  /** Template the user selected for this conversation, if any. */
  selectedTemplate?: string | null;
  /** The user's first name, when the account has one (for the occasional personal touch). */
  userFirstName?: string | null;
  /**
   * What the app did about formatting for the latest message. Absent: nothing
   * was started, and the reply must not claim otherwise.
   */
  formatting?:
    | {
        status: "started";
        templateName: string | null;
        resumeFilename: string | null;
        /** Changes the new version includes, in words ("Without Skills"). */
        changes?: string[];
      }
    | { status: "not_started"; reason: string };
}

/** What the model needs to read the intent of one chat message. */
export interface ChatIntentInput {
  /** The user's latest message. */
  instruction: string;
  /** Recent turns, oldest first. */
  history: ChatTurn[];
  availableTemplates: string[];
  selectedTemplate?: string | null;
  /** A resume is attached in this conversation. */
  hasResume: boolean;
  /** The sections of the attached resume the person can refer to ("Summary" included). */
  resumeSections: string[];
  /** The newest resume already formatted in this chat, if any. */
  lastFormatted?: { template: string; changes: string[] } | null;
}

/** What the person wants the app to do with the latest message. */
export interface ChatIntent {
  /** They ask (or agree) to format their resume into a client template now. */
  format: boolean;
  /** The templates they want, exactly as named in the available list, in order. */
  templates: string[];
  /** Names they used that match no available template. */
  unmatched: string[];
  /** Section names they used that the resume does not have. */
  unmatchedSections: string[];
  /** Changes to the formatted resume they ask for (a section left out, or shown as bullets). */
  edits: { action: "remove" | "restore" | "bullets" | "paragraph"; section: string }[];
}

/** A client template document, as layout evidence (never the raw file). */
export interface AnalyzeTemplateInput {
  /** Display name of the uploaded file. */
  filename: string;
  /** Annotated lines (sizes, positions, heading/list/table markers). */
  digest: string;
  hints: TemplateLayoutHints;
}

/**
 * The only way application code talks to a language model. Implementations
 * must validate model output with the schemas in `./schemas` before returning.
 */
export interface AIProvider {
  readonly id: AIProviderId;
  analyzeResume(input: AnalyzeResumeInput, options?: AIRequestOptions): Promise<ResumeAnalysis>;
  /** Produces a validated FormattingPlan (references to resume content + presentation). */
  formatResume(input: FormatResumeInput, options?: AIRequestOptions): Promise<AIFormattingPlan>;
  /** Produces a validated FillPlan (which template block shows which resume reference). */
  fillTemplate(input: FillTemplateInput, options?: AIRequestOptions): Promise<AIFillPlan>;
  executeResumeTask(input: ResumeTaskInput, options?: AIRequestOptions): Promise<ResumeTaskOutput>;
  /**
   * The same chat task, streamed: yields the Markdown reply in chunks as the
   * model produces them. Completes only when the model finished its answer;
   * otherwise throws an AIProviderError. Aborting `options.signal` cancels the
   * request upstream (the abort reason is rethrown).
   */
  streamResumeTask(input: ResumeTaskInput, options?: AIRequestOptions): AsyncIterable<string>;
  /**
   * Reads what the latest chat message asks the app to do (format the resume,
   * and into which templates) — in any language, with typos and nicknames.
   */
  classifyChatIntent(input: ChatIntentInput, options?: AIRequestOptions): Promise<ChatIntent>;
  /** Identifies a client template's sections, order, layout, typography and placeholders. */
  analyzeTemplate(
    input: AnalyzeTemplateInput,
    options?: AIRequestOptions,
  ): Promise<ClientTemplateStructure>;
  /** Identifier of the model that produced results (stored for traceability). */
  readonly modelName: string;
}
