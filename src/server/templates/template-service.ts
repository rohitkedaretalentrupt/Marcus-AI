import "server-only";

import { AIProviderError } from "@/lib/ai/errors";
import { getAIProvider } from "@/lib/ai/provider";
import type { AIProvider } from "@/lib/ai/types";
import { conversationIdSchema } from "@/lib/chat/validation";
import { getDb } from "@/lib/db/client";
import {
  AppError,
  ERROR_CODES,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@/lib/errors/app-error";
import { FILE_LIMITS } from "@/lib/files/limits";
import { USABLE_FILE_STATUSES } from "@/lib/files/types";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import { clientTemplateStructureSchema } from "@/lib/templates/structure";
import {
  createTemplateSchema,
  selectTemplateSchema,
  TEMPLATE_FAILURES,
  templateIdSchema,
  type TemplateDetail,
  type TemplateFailureCode,
  type TemplateSummary,
} from "@/lib/templates/types";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import { Prisma } from "@/generated/prisma/client";
import { purgeDiscardedFiles } from "@/server/files/file-service";
import { logger } from "@/server/logger";

import { extractTemplateLayout } from "./template-layout";

/*
 * Client templates: an uploaded PDF/DOCX (purpose TEMPLATE, kept unchanged in
 * private object storage) → layout digest → AI structure analysis (validated
 * with Zod) → stored on client_templates.
 *
 * SECURITY: every query filters on the record id AND the session user id.
 * Only layout evidence (never the file or storage key) is sent to the AI.
 */

export interface TemplateDeps {
  getStorage: () => StorageProvider;
  getProvider: () => AIProvider;
}
const defaultDeps: TemplateDeps = { getStorage: getStorageProvider, getProvider: getAIProvider };

export const STALE_TEMPLATE_PROCESSING_MS = 10 * 60 * 1000;
const LAYOUT_TIMEOUT_MS = 60_000;
const MAX_STORED_TEXT = 60_000;
/** Below this many letters/digits the template is treated as having no text. */
const MIN_TEXT_CHARS = 20;
const MAX_TEMPLATES_LISTED = 500;
/** Template names given to the chat assistant as context. */
const MAX_TEMPLATE_NAMES_FOR_AI = 200;
const TEMPLATE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const templateSelect = {
  id: true,
  name: true,
  status: true,
  failureCode: true,
  createdAt: true,
  completedAt: true,
  uploadedFile: { select: { originalFilename: true, mimeType: true } },
} as const satisfies Prisma.ClientTemplateSelect;

type TemplateRow = Prisma.ClientTemplateGetPayload<{ select: typeof templateSelect }>;

function toSummary(row: TemplateRow): TemplateSummary {
  const code = row.failureCode as TemplateFailureCode | null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    filename: row.uploadedFile.originalFilename,
    mimeType: row.uploadedFile.mimeType,
    failureMessage:
      row.status === "FAILED"
        ? (TEMPLATE_FAILURES[code ?? "internal"] ?? TEMPLATE_FAILURES.internal)
        : null,
    awaitingAI: row.status === "FAILED" && code === "ai_not_configured",
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function templateNotFound() {
  return new NotFoundError("Template not found.");
}

function parseTemplateId(value: unknown): string | null {
  const result = templateIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Registers an uploaded template file and claims it for analysis (status
 * PROCESSING). Works without the AI provider: the file is checked and kept,
 * and the template waits (FAILED "ai_not_configured") until AI is configured
 * and the user retries.
 */
export async function createTemplate(userId: string, input: unknown): Promise<TemplateSummary> {
  const { name, fileId } = parseOrThrow(createTemplateSchema, input);
  const db = getDb();

  const file = await db.uploadedFile.findFirst({
    where: { id: fileId, userId, status: { in: [...USABLE_FILE_STATUSES] } },
    select: { purpose: true, mimeType: true, template: { select: { id: true } } },
  });
  if (!file) throw new NotFoundError("File not found.");
  const invalid = (message: string) => new ValidationError([{ path: "fileId", message }], message);
  if (file.purpose !== "TEMPLATE") throw invalid("This file wasn't uploaded as a template.");
  if (!TEMPLATE_MIME_TYPES.has(file.mimeType))
    throw invalid("Templates must be PDF or DOCX files.");
  if (file.template) throw invalid("This file is already used by a template.");

  try {
    const row = await db.clientTemplate.create({
      data: { userId, uploadedFileId: fileId, name, nameKey: name.toLowerCase() },
      select: templateSelect,
    });
    return toSummary(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        publicMessage: "A template with this name already exists.",
      });
    }
    throw error;
  }
}

/** Re-claims a FAILED (or stale PROCESSING) template for another analysis run. */
export async function retryTemplateAnalysis(
  userId: string,
  templateId: unknown,
  deps: Pick<TemplateDeps, "getProvider"> = defaultDeps,
): Promise<TemplateSummary> {
  const id = parseTemplateId(templateId);
  if (!id) throw templateNotFound();
  try {
    deps.getProvider();
  } catch {
    throw new ServiceUnavailableError(
      "Template analysis needs the AI service to be configured first.",
      "Template retry refused: AI provider not configured",
    );
  }
  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_TEMPLATE_PROCESSING_MS);

  const { count } = await db.clientTemplate.updateMany({
    where: {
      id,
      userId,
      OR: [{ status: "FAILED" }, { status: "PROCESSING", startedAt: { lt: staleBefore } }],
    },
    data: { status: "PROCESSING", startedAt: new Date(), completedAt: null, failureCode: null },
  });
  const row = await db.clientTemplate.findFirst({ where: { id, userId }, select: templateSelect });
  if (!row) throw templateNotFound();
  if (count === 0 && row.status !== "PROCESSING") {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      publicMessage: "This template has already been analysed.",
    });
  }
  return toSummary(row);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Template layout timed out")), ms).unref?.(),
    ),
  ]);
}

/**
 * Performs a claimed analysis. Never throws: failures are stored as FAILED
 * with a code. Results are written only while this run still owns the claim.
 */
export async function runTemplateAnalysis(
  userId: string,
  templateId: string,
  deps: TemplateDeps = defaultDeps,
): Promise<TemplateDetail | null> {
  const db = getDb();
  const template = await db.clientTemplate.findFirst({
    where: { id: templateId, userId, status: "PROCESSING" },
    select: {
      startedAt: true,
      uploadedFile: { select: { storageKey: true, mimeType: true, originalFilename: true } },
    },
  });
  if (!template) return null;
  const ownsClaim = {
    id: templateId,
    userId,
    status: "PROCESSING" as const,
    startedAt: template.startedAt,
  };

  const finish = async (data: Prisma.ClientTemplateUpdateManyMutationInput) => {
    await db.clientTemplate.updateMany({
      where: ownsClaim,
      data: { ...data, completedAt: new Date() },
    });
    return getTemplate(userId, templateId);
  };
  const fail = (code: TemplateFailureCode, detail?: string) => {
    logger.warn("Template analysis failed", { templateId, code, detail });
    return finish({ status: "FAILED", failureCode: code });
  };

  try {
    let bytes: Uint8Array;
    try {
      bytes = await deps
        .getStorage()
        .getObject(template.uploadedFile.storageKey as StorageKey, FILE_LIMITS.maxFileBytes);
    } catch {
      return await fail("storage_error");
    }

    let layout;
    try {
      layout = await withTimeout(
        extractTemplateLayout(bytes, template.uploadedFile.mimeType),
        LAYOUT_TIMEOUT_MS,
      );
    } catch {
      return await fail("unreadable");
    }
    if (layout.text.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_TEXT_CHARS)
      return await fail("no_text");

    let provider: AIProvider;
    try {
      provider = deps.getProvider();
    } catch {
      return await fail("ai_not_configured");
    }

    try {
      const structure = await provider.analyzeTemplate({
        filename: template.uploadedFile.originalFilename,
        digest: layout.digest,
        hints: layout.hints,
      });
      return await finish({
        status: "READY",
        structure: structure as Prisma.InputJsonValue,
        extractedText: layout.digest.slice(0, MAX_STORED_TEXT),
        analyzedBy: provider.modelName,
        failureCode: null,
      });
    } catch (error) {
      if (error instanceof AIProviderError) {
        return await fail(
          error.kind === "invalid_response" ? "ai_invalid" : "ai_unavailable",
          error.kind,
        );
      }
      throw error;
    }
  } catch (error) {
    logger.error("Unexpected template analysis error", error, { templateId });
    try {
      return await fail("internal");
    } catch {
      return null;
    }
  }
}

export async function listTemplates(userId: string): Promise<TemplateSummary[]> {
  const rows = await getDb().clientTemplate.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_TEMPLATES_LISTED,
    select: templateSelect,
  });
  return rows.map(toSummary);
}

export async function getTemplate(
  userId: string,
  templateId: unknown,
): Promise<TemplateDetail | null> {
  const id = parseTemplateId(templateId);
  if (!id) return null;
  const row = await getDb().clientTemplate.findFirst({
    where: { id, userId },
    select: { ...templateSelect, structure: true, analyzedBy: true },
  });
  if (!row) return null;
  // Stored JSON is re-validated on the way out; invalid data is never exposed.
  const structure =
    row.status === "READY" ? clientTemplateStructureSchema.safeParse(row.structure) : null;
  return {
    ...toSummary(row),
    structure: structure?.success ? structure.data : null,
    analyzedBy: row.analyzedBy,
  };
}

/** Deletes the template and (best effort) its source file object. */
export async function deleteTemplate(
  userId: string,
  templateId: unknown,
  deps: Pick<TemplateDeps, "getStorage"> = defaultDeps,
): Promise<void> {
  const id = parseTemplateId(templateId);
  if (!id) throw templateNotFound();
  const db = getDb();
  const template = await db.clientTemplate.findFirst({
    where: { id, userId },
    select: { uploadedFileId: true },
  });
  if (!template) throw templateNotFound();

  await db.clientTemplate.deleteMany({ where: { id, userId } }); // conversations: SET NULL
  await purgeDiscardedFiles(userId, [template.uploadedFileId], deps);
}

/** Selects (or clears) the client template for one of the user's conversations. */
export async function selectConversationTemplate(
  userId: string,
  conversationId: unknown,
  input: unknown,
): Promise<{ templateId: string | null }> {
  const conversation = conversationIdSchema.safeParse(conversationId);
  if (!conversation.success) throw new NotFoundError("Conversation not found.");
  const { templateId } = parseOrThrow(selectTemplateSchema, input);
  const db = getDb();

  if (templateId) {
    const template = await db.clientTemplate.findFirst({
      where: { id: templateId, userId, status: "READY" },
      select: { id: true },
    });
    if (!template) {
      throw new ValidationError(
        [{ path: "templateId", message: "Choose one of your analysed templates." }],
        "Choose one of your analysed templates.",
      );
    }
  }

  const { count } = await db.conversation.updateMany({
    where: { id: conversation.data, userId },
    data: { clientTemplateId: templateId },
  });
  if (count === 0) throw new NotFoundError("Conversation not found.");
  return { templateId };
}

/** Names of the user's analysed templates and the conversation's selected one (for AI context). */
export async function templateContextFor(userId: string, conversationId: string) {
  const db = getDb();
  const [templates, conversation] = await Promise.all([
    db.clientTemplate.findMany({
      where: { userId, status: "READY" },
      orderBy: { name: "asc" },
      take: MAX_TEMPLATE_NAMES_FOR_AI,
      select: { name: true },
    }),
    db.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { clientTemplate: { select: { name: true, status: true } } },
    }),
  ]);
  const selected = conversation?.clientTemplate;
  return {
    availableTemplates: templates.map((template) => template.name),
    selectedTemplate: selected?.status === "READY" ? selected.name : null,
  };
}
