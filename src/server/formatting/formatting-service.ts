import "server-only";

import { randomBytes } from "node:crypto";

import { AIProviderError } from "@/lib/ai/errors";
import { getAIProvider } from "@/lib/ai/provider";
import type { AIProvider } from "@/lib/ai/types";
import { getDb } from "@/lib/db/client";
import { expectedTexts, validateDocx } from "@/lib/documents/docx/docx-validation";
import { comparable } from "@/lib/documents/docx/text";
import { getDocumentRenderer } from "@/lib/documents/renderer";
import { resumeContentSchema, type ResumeContent } from "@/lib/documents/resume-content";
import type { DocumentRenderer } from "@/lib/documents/types";
import {
  AppError,
  ERROR_CODES,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "@/lib/errors/app-error";
import { FILE_LIMITS } from "@/lib/files/limits";
import { USABLE_FILE_STATUSES } from "@/lib/files/types";
import { conversationIdSchema } from "@/lib/chat/validation";
import {
  matchTemplateName,
  requestedTemplateName,
  startChatFormattingSchema,
} from "@/lib/formatting/chat-request";
import { generatedFilename } from "@/lib/formatting/filename";
import { contentShownByPlan, toAIResumeView } from "@/lib/formatting/content-refs";
import type { FillPlan } from "@/lib/formatting/fill-plan";
import {
  contentShownByFillPlan,
  finalizeFillPlan,
  sampleValues,
  type FinalizeFillResult,
} from "@/lib/formatting/finalize-fill-plan";
import { finalizePlan, type FinalizeResult, type PlanSource } from "@/lib/formatting/finalize-plan";
import type { AIFormattingPlan } from "@/lib/formatting/plan";
import { fillDocxTemplate, readTemplateBlocks } from "@/lib/documents/docx/template-fill";
import {
  createFormattingJobSchema,
  FORMATTING_ENGINE_VERSION,
  FORMATTING_FAILURES,
  formattingJobIdSchema,
  type FormattableResume,
  type FormattingFailureCode,
  type FormattingJobView,
} from "@/lib/formatting/types";
import { buildStorageKey, isKeyOwnedBy } from "@/lib/storage/keys";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import {
  clientTemplateStructureSchema,
  type ClientTemplateStructure,
} from "@/lib/templates/structure";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/server/logger";

/*
 * Resume formatting jobs:
 *
 *   READY resume (ResumeContent) + READY client template (structure)
 *     → AI FormattingPlan (validated with Zod; one correction on invalid JSON)
 *     → finalizePlan (completeness, headings, template order/facts; one AI
 *       correction if anything is wrong, then deterministic fixes + warnings)
 *     → deterministic DOCX renderer → DOCX validation
 *     → private object storage (users/{userId}/generated/…) → COMPLETED
 *
 * Statuses: QUEUED → PROCESSING → COMPLETED | FAILED. Runs in the app process
 * after the response (no durable queue). Each run claims the job with a new
 * `startedAt`, and every write requires that claim, so an older run can never
 * overwrite a newer one. `activeKey` (unique) allows one active job per
 * resume + template. Stuck jobs become retryable after a timeout.
 *
 * SECURITY: every query filters on the record id AND the session user id.
 * The original resume and template files are never read or modified here.
 * Resume content, prompts and AI output are never logged.
 */

export interface FormattingDeps {
  getStorage: () => StorageProvider;
  getProvider: () => AIProvider;
  getRenderer: () => DocumentRenderer;
  /** Overrides PLANNING_DEADLINE_MS (tests). */
  planningDeadlineMs?: number;
  /** Overrides RESUME_WAIT_MS (tests). */
  resumeWaitMs?: number;
}
const defaultDeps: FormattingDeps = {
  getStorage: getStorageProvider,
  getProvider: getAIProvider,
  getRenderer: () => getDocumentRenderer("docx"),
};

/**
 * A QUEUED job not picked up within this time was lost (e.g. a restart).
 * Generous, because queued jobs may wait for a free processing slot.
 */
export const STALE_QUEUED_MS = 10 * 60 * 1000;
/** A PROCESSING run older than this is considered abandoned. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;
const RENDER_TIMEOUT_MS = 30_000;
/** Overall time budget for the AI planning of one run (all requests + correction). */
export const PLANNING_DEADLINE_MS = 4 * 60 * 1000;
/** Resume data sent to the AI is capped; longer resumes fail with a clear message. */
export const MAX_FORMAT_INPUT_CHARS = 60_000;
/** A job started from chat may wait this long for its resume to finish being read. */
export const RESUME_WAIT_MS = 90_000;
const RESUME_POLL_MS = 1_500;
/** Active (queued or processing) jobs one user may have at a time. */
export const MAX_ACTIVE_JOBS_PER_USER = 3;
const MAX_JOBS_LISTED = 20;
const MAX_RESUMES_LISTED = 50;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// --- views -------------------------------------------------------------------

const jobSelect = {
  id: true,
  status: true,
  failureCode: true,
  warnings: true,
  aiModel: true,
  engineVersion: true,
  resumeFileId: true,
  clientTemplateId: true,
  conversationId: true,
  startedAt: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  resumeFile: { select: { id: true, originalFilename: true } },
  clientTemplate: { select: { id: true, name: true } },
  document: { select: { filename: true, sizeBytes: true } },
} as const satisfies Prisma.FormattingJobSelect;

type JobRow = Prisma.FormattingJobGetPayload<{ select: typeof jobSelect }>;

function isStale(job: Pick<JobRow, "status" | "startedAt" | "updatedAt">, now = Date.now()) {
  if (job.status === "QUEUED") return now - job.updatedAt.getTime() > STALE_QUEUED_MS;
  if (job.status === "PROCESSING") {
    return now - (job.startedAt ?? job.updatedAt).getTime() > STALE_PROCESSING_MS;
  }
  return false;
}

function canRetry(job: JobRow): boolean {
  return (
    (job.status === "FAILED" || isStale(job)) &&
    job.resumeFileId !== null &&
    job.clientTemplateId !== null
  );
}

const warningsOf = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function toView(row: JobRow): FormattingJobView {
  const code = row.failureCode as FormattingFailureCode | null;
  return {
    id: row.id,
    status: row.status,
    resume: row.resumeFile
      ? { fileId: row.resumeFile.id, filename: row.resumeFile.originalFilename }
      : null,
    template: row.clientTemplate,
    failureMessage:
      row.status === "FAILED"
        ? (FORMATTING_FAILURES[code ?? "internal"] ?? FORMATTING_FAILURES.internal)
        : null,
    warnings: warningsOf(row.warnings),
    document: row.status === "COMPLETED" ? row.document : null,
    canRetry: canRetry(row),
    aiModel: row.aiModel,
    engineVersion: row.engineVersion,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function jobNotFound() {
  return new NotFoundError("Formatting job not found.");
}

function conflict(publicMessage: string) {
  return new AppError({ code: ERROR_CODES.CONFLICT, status: 409, publicMessage });
}

function parseJobId(value: unknown): string | null {
  const result = formattingJobIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

// --- queries -------------------------------------------------------------------

export async function getFormattingJob(
  userId: string,
  jobId: unknown,
): Promise<FormattingJobView | null> {
  const id = parseJobId(jobId);
  if (!id) return null;
  const row = await getDb().formattingJob.findFirst({ where: { id, userId }, select: jobSelect });
  return row ? toView(row) : null;
}

export async function listFormattingJobs(userId: string): Promise<FormattingJobView[]> {
  const rows = await getDb().formattingJob.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_JOBS_LISTED,
    select: jobSelect,
  });
  return rows.map(toView);
}

/** The user's resumes that can be formatted (uploaded files with a READY extraction). */
export async function listFormattableResumes(userId: string): Promise<FormattableResume[]> {
  const rows = await getDb().resumeExtraction.findMany({
    where: {
      userId,
      status: "READY",
      uploadedFile: { userId, status: { in: [...USABLE_FILE_STATUSES] }, purpose: "ATTACHMENT" },
    },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: MAX_RESUMES_LISTED,
    select: {
      uploadedFileId: true,
      content: true,
      completedAt: true,
      uploadedFile: { select: { originalFilename: true } },
    },
  });
  return rows.map((row) => {
    const content = resumeContentSchema.safeParse(row.content);
    return {
      fileId: row.uploadedFileId,
      filename: row.uploadedFile.originalFilename,
      candidateName: content.success ? content.data.contact.fullName : null,
      extractedAt: row.completedAt?.toISOString() ?? null,
    };
  });
}

// --- create / retry / delete --------------------------------------------------

/**
 * Creates a QUEUED job for the user's READY resume and READY template. If an
 * active job already exists for the same pair, that job is returned instead
 * (`created: false`); a stuck one is marked FAILED and replaced.
 */
export async function createFormattingJob(
  userId: string,
  input: unknown,
  deps: Pick<FormattingDeps, "getProvider" | "getStorage"> = defaultDeps,
  options: {
    /** Show the job in this (already ownership-checked) conversation. */
    conversationId?: string;
    /** Accept a resume that is still being read; the run waits for it. */
    allowPendingResume?: boolean;
  } = {},
): Promise<{ job: FormattingJobView; created: boolean }> {
  const { resumeFileId, templateId } = parseOrThrow(createFormattingJobSchema, input);
  // 503 up front if formatting cannot run (AI or storage not configured).
  deps.getProvider();
  deps.getStorage();
  const db = getDb();

  const resume = await db.resumeExtraction.findFirst({
    where: {
      uploadedFileId: resumeFileId,
      userId,
      uploadedFile: { userId, status: { in: [...USABLE_FILE_STATUSES] }, purpose: "ATTACHMENT" },
    },
    select: { status: true },
  });
  if (!resume) throw new NotFoundError("Resume not found.");
  const pendingOk = options.allowPendingResume && resume.status === "PROCESSING";
  if (resume.status !== "READY" && !pendingOk) {
    const message =
      resume.status === "PROCESSING"
        ? "This resume is still being read. Try again in a moment."
        : "This resume couldn't be read, so it can't be formatted.";
    throw new ValidationError([{ path: "resumeFileId", message }], message);
  }
  const template = await db.clientTemplate.findFirst({
    where: { id: templateId, userId },
    select: { status: true },
  });
  if (!template) throw new NotFoundError("Template not found.");
  if (template.status !== "READY") {
    const message = "This template hasn't been analysed successfully yet.";
    throw new ValidationError([{ path: "templateId", message }], message);
  }

  const activeKey = `${resumeFileId}:${templateId}`;
  const now = Date.now();
  const others = await db.formattingJob.findMany({
    where: { userId, status: { in: ["QUEUED", "PROCESSING"] }, NOT: { activeKey } },
    select: { status: true, startedAt: true, updatedAt: true },
    take: MAX_ACTIVE_JOBS_PER_USER + 1,
  });
  if (others.filter((job) => !isStale(job, now)).length >= MAX_ACTIVE_JOBS_PER_USER) {
    throw new RateLimitError(
      `You can format up to ${MAX_ACTIVE_JOBS_PER_USER} resumes at a time. Wait for one to finish.`,
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await db.formattingJob.create({
        data: {
          userId,
          resumeFileId,
          clientTemplateId: templateId,
          activeKey,
          engineVersion: FORMATTING_ENGINE_VERSION,
          conversationId: options.conversationId,
        },
        select: jobSelect,
      });
      return { job: toView(row), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const active = await db.formattingJob.findFirst({
      where: { activeKey, userId },
      select: jobSelect,
    });
    if (!active) continue; // finished in the meantime
    if (!isStale(active)) return { job: toView(active), created: false };
    await db.formattingJob.updateMany({
      where: { id: active.id, userId, status: active.status, updatedAt: active.updatedAt },
      data: { status: "FAILED", failureCode: "stale", activeKey: null, completedAt: new Date() },
    });
  }
  throw conflict("This resume is already being formatted with this template.");
}

/** Re-queues a FAILED (or stuck) job. */
export async function retryFormattingJob(
  userId: string,
  jobId: unknown,
  deps: Pick<FormattingDeps, "getProvider" | "getStorage"> = defaultDeps,
): Promise<FormattingJobView> {
  const id = parseJobId(jobId);
  if (!id) throw jobNotFound();
  // 503 up front instead of queueing a run that cannot succeed.
  deps.getProvider();
  deps.getStorage();
  const db = getDb();
  const job = await db.formattingJob.findFirst({ where: { id, userId }, select: jobSelect });
  if (!job) throw jobNotFound();
  if (job.status !== "FAILED" && !isStale(job)) {
    throw conflict(
      job.status === "COMPLETED"
        ? "This job has already completed. Start a new one to format again."
        : "This job is still running.",
    );
  }
  if (!job.resumeFileId || !job.clientTemplateId) {
    throw conflict("The resume or template for this job no longer exists.");
  }

  try {
    const { count } = await db.formattingJob.updateMany({
      where: { id, userId, status: job.status, updatedAt: job.updatedAt },
      data: {
        status: "QUEUED",
        activeKey: `${job.resumeFileId}:${job.clientTemplateId}`,
        failureCode: null,
        plan: Prisma.DbNull,
        warnings: Prisma.DbNull,
        completedAt: null,
      },
    });
    if (count === 0) throw conflict("This job changed. Refresh and try again.");
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("This resume is already being formatted with this template.");
    }
    throw error;
  }
  const row = await db.formattingJob.findFirst({ where: { id, userId }, select: jobSelect });
  if (!row) throw jobNotFound();
  return toView(row);
}

/** Deletes a finished job and its generated document (object first, then rows). */
export async function deleteFormattingJob(
  userId: string,
  jobId: unknown,
  deps: Pick<FormattingDeps, "getStorage"> = defaultDeps,
): Promise<void> {
  const id = parseJobId(jobId);
  if (!id) throw jobNotFound();
  const db = getDb();
  const job = await db.formattingJob.findFirst({
    where: { id, userId },
    select: { ...jobSelect, document: { select: { storageKey: true } } },
  });
  if (!job) throw jobNotFound();
  if ((job.status === "QUEUED" || job.status === "PROCESSING") && !isStale(job)) {
    throw conflict("This job is still running.");
  }
  if (job.document) {
    const key = job.document.storageKey as StorageKey;
    if (isKeyOwnedBy(key, userId)) await deps.getStorage().delete(key);
  }
  await db.formattingJob.deleteMany({ where: { id, userId } });
}

/** A short-lived signed download URL for a completed job's DOCX. */
export async function createFormattedDownloadUrl(
  userId: string,
  jobId: unknown,
  deps: Pick<FormattingDeps, "getStorage"> = defaultDeps,
): Promise<{ url: string; expiresAt: string; filename: string }> {
  const id = parseJobId(jobId);
  if (!id) throw jobNotFound();
  const document = await getDb().generatedDocument.findFirst({
    where: { formattingJobId: id, userId, job: { userId, status: "COMPLETED" } },
    select: { storageKey: true, filename: true, mimeType: true },
  });
  const key = document?.storageKey as StorageKey | undefined;
  if (!document || !key || !isKeyOwnedBy(key, userId)) {
    throw new NotFoundError("The formatted document isn't available.");
  }
  let storage: StorageProvider;
  try {
    storage = deps.getStorage();
  } catch (error) {
    if (error instanceof AppError && error.status === 503) {
      throw new ServiceUnavailableError("Downloads aren't available right now.", error.message);
    }
    throw error;
  }
  const { url, expiresAt } = await storage.createDownloadUrl(key, {
    expiresInSeconds: FILE_LIMITS.downloadUrlTtlSeconds,
    downloadFilename: document.filename,
    contentType: document.mimeType,
  });
  return { url, expiresAt: expiresAt.toISOString(), filename: document.filename };
}

/** Largest generated document read for an in-app preview. */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/** The caller's own generated DOCX, read through the server for the in-app preview. */
export async function readFormattedResume(
  userId: string,
  jobId: unknown,
  deps: Pick<FormattingDeps, "getStorage"> = defaultDeps,
): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  const id = parseJobId(jobId);
  if (!id) throw jobNotFound();
  const document = await getDb().generatedDocument.findFirst({
    where: { formattingJobId: id, userId, job: { userId, status: "COMPLETED" } },
    select: { storageKey: true, filename: true, mimeType: true },
  });
  const key = document?.storageKey as StorageKey | undefined;
  if (!document || !key || !isKeyOwnedBy(key, userId)) {
    throw new NotFoundError("The formatted document isn't available.");
  }
  let storage: StorageProvider;
  try {
    storage = deps.getStorage();
  } catch (error) {
    if (error instanceof AppError && error.status === 503) {
      throw new ServiceUnavailableError("Previews aren't available right now.", error.message);
    }
    throw error;
  }
  const bytes = await storage.getObject(key, MAX_PREVIEW_BYTES);
  return { bytes, filename: document.filename, mimeType: document.mimeType };
}

// --- chat -------------------------------------------------------------------------

/** Formatting jobs started from one of the user's conversations, oldest first. */
export async function listConversationFormattingJobs(
  userId: string,
  conversationId: string,
): Promise<FormattingJobView[]> {
  const rows = await getDb().formattingJob.findMany({
    where: { userId, conversationId, conversation: { userId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_JOBS_LISTED,
    select: jobSelect,
  });
  return rows.map(toView);
}

function chatProblem(path: string, message: string) {
  return new ValidationError([{ path, message }], message);
}

/**
 * Starts formatting from a chat. The resume is one attached in this
 * conversation (the newest by default; it may still be being read). The
 * template is the one given, else one named in the user's message, else the
 * conversation's selected template. Everything is owner-scoped.
 */
export async function startFormattingFromChat(
  userId: string,
  conversationId: unknown,
  input: unknown,
  deps: Pick<FormattingDeps, "getProvider" | "getStorage"> = defaultDeps,
): Promise<{ job: FormattingJobView; created: boolean }> {
  const conversationIdResult = conversationIdSchema.safeParse(conversationId);
  if (!conversationIdResult.success) throw new NotFoundError("Conversation not found.");
  const id = conversationIdResult.data;
  const { resumeFileId, templateId, text, previousReply } = parseOrThrow(
    startChatFormattingSchema,
    input,
  );
  try {
    deps.getProvider();
  } catch {
    throw new ServiceUnavailableError(
      "Formatting needs the AI service to be configured. Your resume and templates are saved, so you can format as soon as it is.",
      "Chat formatting refused: AI provider not configured",
    );
  }
  const db = getDb();

  const conversation = await db.conversation.findFirst({
    where: { id, userId },
    select: { clientTemplateId: true },
  });
  if (!conversation) throw new NotFoundError("Conversation not found.");

  // Resume: attached in THIS conversation, readable (or still being read).
  const attachment = await db.messageAttachment.findFirst({
    where: {
      message: { conversationId: id, conversation: { userId } },
      ...(resumeFileId ? { uploadedFileId: resumeFileId } : {}),
      uploadedFile: {
        userId,
        purpose: "ATTACHMENT",
        status: { in: [...USABLE_FILE_STATUSES] },
        extraction: { status: { in: ["READY", "PROCESSING"] } },
      },
    },
    orderBy: [{ message: { createdAt: "desc" } }, { position: "desc" }],
    select: { uploadedFileId: true },
  });
  if (!attachment) {
    throw chatProblem(
      "resumeFileId",
      resumeFileId
        ? "That resume isn't attached to this chat or couldn't be read."
        : "Attach a PDF or DOCX resume in this chat first, then ask me to format it.",
    );
  }

  // Template: explicit → named in the message → named in the reply it answers
  // ("Want me to use Zillow?" → "yes") → selected for this chat.
  let chosenTemplateId = templateId ?? null;
  if (!chosenTemplateId && (text || previousReply)) {
    const templates = await db.clientTemplate.findMany({
      where: { userId },
      select: { id: true, name: true },
      take: 500,
    });
    const names = templates.map((template) => template.name);
    const inText = text ? matchTemplateName(text, names) : null;
    // "Format as per Abbott" with no Abbott template: say so rather than
    // quietly using another template.
    const asked = text && !inText ? requestedTemplateName(text) : null;
    if (asked) {
      throw chatProblem(
        "templateId",
        names.length
          ? `There's no client template called "${asked}". Your templates: ${names.join(", ")}. Add it on the Templates page, or name one of these.`
          : `There's no client template called "${asked}" — you don't have any client templates yet. Add one on the Templates page first.`,
      );
    }
    const named = inText ?? (previousReply ? matchTemplateName(previousReply, names) : null);
    chosenTemplateId = templates.find((template) => template.name === named)?.id ?? null;
  }
  chosenTemplateId ??= conversation.clientTemplateId;
  if (!chosenTemplateId) {
    throw chatProblem(
      "templateId",
      'Which client template should I use? Name it in your message, e.g. "Format my resume using Client A", or select one with ⋮ → Client template.',
    );
  }

  return createFormattingJob(
    userId,
    { resumeFileId: attachment.uploadedFileId, templateId: chosenTemplateId },
    deps,
    { conversationId: id, allowPendingResume: true },
  );
}

// --- processing ------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function aiFailure(error: AIProviderError): FormattingFailureCode {
  if (error.kind === "timeout") return "ai_timeout";
  if (error.kind === "invalid_response") return "ai_invalid";
  return "ai_unavailable";
}

/**
 * AI plan → checks → (one correction) → final plan. A failed correction
 * falls back to the first plan, which `finalizePlan` has already completed.
 */
async function planFormatting(
  provider: AIProvider,
  content: ResumeContent,
  template: ClientTemplateStructure,
  source: Parameters<typeof finalizePlan>[3],
  signal: AbortSignal,
): Promise<FinalizeResult> {
  const first: AIFormattingPlan = await provider.formatResume(
    { resume: content, template },
    { signal },
  );
  const firstResult = finalizePlan(first, content, template, source);
  if (firstResult.issues.length === 0) return firstResult;

  try {
    const corrected = await provider.formatResume(
      {
        resume: content,
        template,
        correction: { previousPlan: first, issues: firstResult.issues },
      },
      { signal },
    );
    return finalizePlan(corrected, content, template, source);
  } catch (error) {
    if (!(error instanceof AIProviderError) || signal.aborted) throw error;
    logger.warn("Formatting plan correction failed; using the completed first plan", {
      kind: error.kind,
    });
    return firstResult;
  }
}

/** Fill plans made in parallel per job; the best one is used. */
const FILL_CANDIDATES = 3;

/**
 * Lower is better: content pushed to the "Additional Information" part
 * weighs most, then sample details the plan forgot, then open issues.
 */
function fillScore(result: FinalizeFillResult): number {
  const removed = Number(
    /removed \((\d+)\)/.exec(
      result.warnings.find((w) => w.startsWith("Sample details")) ?? "",
    )?.[1] ?? 0,
  );
  return result.plan.additional.length * 100 + removed * 3 + result.issues.length;
}

/** One fill plan: the AI's plan, checked; one correction when the checks found issues. */
async function planFill(
  provider: AIProvider,
  content: ResumeContent,
  blocks: Awaited<ReturnType<typeof readTemplateBlocks>>,
  source: PlanSource,
  samples: readonly string[],
  signal: AbortSignal,
): Promise<FinalizeFillResult> {
  const first = await provider.fillTemplate({ resume: content, blocks }, { signal });
  const planned = finalizeFillPlan(first, content, blocks, source, samples);
  if (planned.issues.length === 0) return planned;
  try {
    const corrected = await provider.fillTemplate(
      { resume: content, blocks, correction: { previousPlan: first, issues: planned.issues } },
      { signal },
    );
    const second = finalizeFillPlan(corrected, content, blocks, source, samples);
    // A correction can forget parts that were right: keep the better plan.
    return fillScore(second) <= fillScore(planned) ? second : planned;
  } catch (error) {
    if (!(error instanceof AIProviderError) || signal.aborted) throw error;
    logger.warn("Fill plan correction failed; using the checked first plan", { kind: error.kind });
    return planned;
  }
}

/** Why the fill engine gave way to the generator (stored as a job warning). */
const FILL_FALLBACK_WARNING =
  "The template could not be filled in place, so a document in the template's style was generated instead.";

type FillOutcome =
  | { ok: true; data: Uint8Array; plan: FillPlan; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Fill engine for DOCX templates: the template's blocks → AI FillPlan →
 * checks (one correction) → a filled copy of the template → validation.
 * Any problem that is not an AI outage returns `ok: false` so the caller can
 * fall back to the generator; AI errors are thrown for the caller to map.
 */
async function fillTemplateDocx(
  provider: AIProvider,
  templateBytes: Uint8Array,
  content: ResumeContent,
  source: PlanSource,
  signal: AbortSignal,
  /** Sample values the template analysis found (the template's example person). */
  samples: readonly string[],
): Promise<FillOutcome> {
  let blocks: Awaited<ReturnType<typeof readTemplateBlocks>>;
  try {
    blocks = await readTemplateBlocks(templateBytes);
  } catch (error) {
    return {
      ok: false,
      reason: `unreadable template: ${error instanceof Error ? error.name : "?"}`,
    };
  }
  if (blocks.length === 0) return { ok: false, reason: "template has no blocks" };

  // Mapping a form is not equally good every time, so several plans are made
  // in parallel and the best one is kept (each may get one correction).
  const candidates = await Promise.allSettled(
    Array.from({ length: FILL_CANDIDATES }, () =>
      planFill(provider, content, blocks, source, samples, signal),
    ),
  );
  const plans = candidates
    .filter((c): c is PromiseFulfilledResult<FinalizeFillResult> => c.status === "fulfilled")
    .map((c) => c.value);
  if (plans.length === 0) {
    const reason = (candidates[0] as PromiseRejectedResult).reason as unknown;
    if (reason instanceof AIProviderError && reason.kind === "invalid_response") {
      return { ok: false, reason: "ai_invalid" };
    }
    throw reason;
  }
  // Best plan first; a plan whose filled document fails validation gives
  // way to the next one before falling back to the generator.
  const ranked = [...plans].sort((a, b) => fillScore(a) - fillScore(b));
  let firstProblem: string | null = null;
  for (const planned of ranked) {
    const outcome = await fillAndValidate(templateBytes, planned, content, samples);
    if (outcome.ok) return outcome;
    firstProblem ??= outcome.reason;
  }
  return { ok: false, reason: firstProblem ?? "no fill plan" };
}

/** Fills the template with one checked plan and validates the result. */
async function fillAndValidate(
  templateBytes: Uint8Array,
  planned: FinalizeFillResult,
  content: ResumeContent,
  samples: readonly string[],
): Promise<FillOutcome> {
  if (planned.plan.fills.length === 0 && planned.plan.groups.length === 0) {
    return { ok: false, reason: "empty fill plan" };
  }
  const shown = contentShownByFillPlan(content, planned.plan);
  let filled: Awaited<ReturnType<typeof fillDocxTemplate>>;
  try {
    filled = await withTimeout(
      fillDocxTemplate(templateBytes, planned.plan, shown),
      RENDER_TIMEOUT_MS,
      "Template filling",
    );
  } catch (error) {
    return { ok: false, reason: `fill failed: ${error instanceof Error ? error.name : "?"}` };
  }
  // The sample person's details must be gone (unless the candidate shares them).
  const resumeText = comparable(expectedTexts(shown).join(" ")).toLowerCase();
  const sampleTexts = sampleValues(samples)
    .map((sample) => comparable(sample))
    .filter((sample) => !resumeText.includes(sample.toLowerCase()));
  const validation = await validateDocx(filled.data, shown, {
    mode: "filled",
    forbiddenTexts: [...filled.forbiddenTexts, ...sampleTexts],
  });
  if (!validation.ok) return { ok: false, reason: validation.problems.join("; ") };
  return {
    ok: true,
    data: filled.data,
    plan: planned.plan,
    warnings: [...planned.warnings, ...filled.warnings],
  };
}

/**
 * Claims a QUEUED job and performs it. Never throws: failures are stored as
 * FAILED with a code. Returns null if the job could not be claimed.
 */
export async function runFormattingJob(
  userId: string,
  jobId: string,
  deps: FormattingDeps = defaultDeps,
): Promise<FormattingJobView | null> {
  const db = getDb();
  const startedAt = new Date();
  const claimed = await db.formattingJob.updateMany({
    where: { id: jobId, userId, status: "QUEUED" },
    data: { status: "PROCESSING", startedAt, attempts: { increment: 1 }, completedAt: null },
  });
  if (claimed.count === 0) return null;
  const ownsClaim = { id: jobId, userId, status: "PROCESSING" as const, startedAt };

  const fail = async (code: FormattingFailureCode, detail?: string) => {
    logger.warn("Formatting job failed", { jobId, code, detail });
    await db.formattingJob.updateMany({
      where: ownsClaim,
      data: { status: "FAILED", failureCode: code, activeKey: null, completedAt: new Date() },
    });
    return getFormattingJob(userId, jobId);
  };

  let storedKey: StorageKey | null = null;
  try {
    const job = await db.formattingJob.findFirst({
      where: { id: jobId, userId },
      select: { resumeFileId: true, clientTemplateId: true },
    });
    if (!job) return null;

    // A resume attached moments ago may still be being read: wait for it.
    if (job.resumeFileId) {
      const waitUntil = Date.now() + (deps.resumeWaitMs ?? RESUME_WAIT_MS);
      for (;;) {
        const pending = await db.resumeExtraction.findFirst({
          where: { uploadedFileId: job.resumeFileId, userId, status: "PROCESSING" },
          select: { id: true },
        });
        if (!pending || Date.now() >= waitUntil) break;
        await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
      }
    }

    // Inputs: owner-scoped, READY, re-validated.
    const extraction = job.resumeFileId
      ? await db.resumeExtraction.findFirst({
          where: {
            uploadedFileId: job.resumeFileId,
            userId,
            status: "READY",
            uploadedFile: { userId, status: { in: [...USABLE_FILE_STATUSES] } },
          },
          select: { content: true, parserVersion: true, completedAt: true },
        })
      : null;
    const content = resumeContentSchema.safeParse(extraction?.content);
    if (!extraction || !content.success) return await fail("resume_unavailable");

    const templateRow = job.clientTemplateId
      ? await db.clientTemplate.findFirst({
          where: { id: job.clientTemplateId, userId, status: "READY" },
          select: {
            name: true,
            structure: true,
            completedAt: true,
            uploadedFile: { select: { storageKey: true, mimeType: true } },
          },
        })
      : null;
    const structure = clientTemplateStructureSchema.safeParse(templateRow?.structure);
    if (!templateRow || !structure.success) return await fail("template_unavailable");

    // AI input size limit (the content itself is never truncated: that would drop facts).
    if (JSON.stringify(toAIResumeView(content.data)).length > MAX_FORMAT_INPUT_CHARS) {
      return await fail("too_large");
    }

    let provider: AIProvider;
    let storage: StorageProvider;
    try {
      provider = deps.getProvider();
      storage = deps.getStorage();
    } catch {
      return await fail("ai_unavailable", "not_configured");
    }

    const templateAnalyzedAt = templateRow.completedAt?.toISOString() ?? null;
    const source: PlanSource = {
      resumeFileId: job.resumeFileId!,
      templateId: job.clientTemplateId!,
      templateAnalyzedAt,
      engineVersion: FORMATTING_ENGINE_VERSION,
    };
    const deadline = AbortSignal.timeout(deps.planningDeadlineMs ?? PLANNING_DEADLINE_MS);

    // 1. DOCX templates: fill a copy of the client's own document. The
    // template file is read, never written. Anything other than an AI outage
    // falls back to the generator below, so the user still gets a document.
    let data: Uint8Array | null = null;
    let storedPlan: FillPlan | FinalizeResult["plan"] | null = null;
    const warnings: string[] = [];
    if (templateRow.uploadedFile.mimeType === DOCX_MIME) {
      let outcome: FillOutcome;
      try {
        const templateBytes = await storage.getObject(
          templateRow.uploadedFile.storageKey as StorageKey,
          FILE_LIMITS.maxFileBytes,
        );
        outcome = await fillTemplateDocx(
          provider,
          templateBytes,
          content.data,
          source,
          deadline,
          structure.data.placeholders.map((placeholder) => placeholder.text),
        );
      } catch (error) {
        if (deadline.aborted) return await fail("ai_timeout", "planning_deadline");
        if (error instanceof AIProviderError) return await fail(aiFailure(error), error.kind);
        outcome = { ok: false, reason: error instanceof Error ? error.name : "unknown" };
      }
      if (outcome.ok) {
        data = outcome.data;
        storedPlan = outcome.plan;
        warnings.push(...outcome.warnings);
      } else {
        logger.warn("Template fill fell back to the generator", { jobId, reason: outcome.reason });
        warnings.push(FILL_FALLBACK_WARNING);
      }
    }

    if (!data) {
      // 2. Generator: AI FormattingPlan → deterministic renderer.
      let planned: FinalizeResult;
      try {
        planned = await planFormatting(provider, content.data, structure.data, source, deadline);
      } catch (error) {
        if (deadline.aborted) return await fail("ai_timeout", "planning_deadline");
        if (error instanceof AIProviderError) return await fail(aiFailure(error), error.kind);
        throw error;
      }
      storedPlan = planned.plan;
      warnings.push(...planned.warnings);

      // Contact details the template has no place for are not part of the
      // document, so they are neither rendered nor expected.
      const shown = contentShownByPlan(content.data, planned.plan);
      try {
        const rendered = await withTimeout(
          deps.getRenderer().render({ content: shown, plan: planned.plan }),
          RENDER_TIMEOUT_MS,
          "DOCX rendering",
        );
        data = rendered.data;
      } catch (error) {
        return await fail("render_failed", error instanceof Error ? error.name : undefined);
      }

      // 3. Validate before anything is stored
      const validation = await validateDocx(data, shown);
      if (!validation.ok) return await fail("validation_failed", validation.problems.join("; "));
    }

    // 4. Store privately and verify
    const documentId = randomBytes(16).toString("hex");
    const key = buildStorageKey({
      userId,
      category: "generated",
      objectId: documentId,
      extension: "docx",
    });
    try {
      await storage.putObject(key, data, DOCX_MIME);
      const stored = await storage.head(key);
      if (!stored || stored.sizeBytes !== data.length) throw new Error("stored size mismatch");
      storedKey = key;
    } catch (error) {
      // The write may have partly succeeded: remove whatever is there (idempotent).
      await storage.delete(key).catch(() => {});
      return await fail("storage_error", error instanceof Error ? error.name : undefined);
    }

    // 5. Commit only while this run still owns the claim
    const committed = await db.$transaction(async (tx) => {
      const { count } = await tx.formattingJob.updateMany({
        where: ownsClaim,
        data: {
          status: "COMPLETED",
          plan: storedPlan as unknown as Prisma.InputJsonValue,
          warnings,
          aiModel: provider.modelName,
          engineVersion: FORMATTING_ENGINE_VERSION,
          resumeParserVersion: extraction.parserVersion,
          resumeExtractedAt: extraction.completedAt,
          templateAnalyzedAt: templateRow.completedAt,
          failureCode: null,
          activeKey: null,
          completedAt: new Date(),
        },
      });
      if (count === 0) return false;
      await tx.generatedDocument.create({
        data: {
          id: documentId,
          userId,
          formattingJobId: jobId,
          storageKey: key,
          filename: generatedFilename(content.data.contact.fullName, templateRow.name),
          mimeType: DOCX_MIME,
          sizeBytes: data.length,
        },
      });
      return true;
    });
    if (!committed) {
      logger.warn("Formatting run lost its claim; discarding its output", { jobId });
      await storage.delete(key).catch(() => {});
      return getFormattingJob(userId, jobId);
    }
    storedKey = null;
    return await getFormattingJob(userId, jobId);
  } catch (error) {
    logger.error("Unexpected formatting job error", error, { jobId });
    if (storedKey)
      await deps
        .getStorage()
        .delete(storedKey)
        .catch(() => {});
    try {
      return await fail("internal");
    } catch {
      return null;
    }
  }
}
