import "server-only";

import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { resumeContentSchema } from "@/lib/documents/resume-content";
import { AppError, ERROR_CODES, NotFoundError } from "@/lib/errors/app-error";
import { FILE_LIMITS } from "@/lib/files/limits";
import { USABLE_FILE_STATUSES } from "@/lib/files/types";
import { fileIdSchema } from "@/lib/files/validation";
import {
  NoExtractableTextError,
  parseResumeText,
  PARSER_VERSION,
} from "@/lib/resumes/parse-resume";
import {
  EXTRACTION_FAILURES,
  type ExtractionFailureCode,
  type ResumeExtractionView,
} from "@/lib/resumes/types";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/server/logger";

import { extractorFor } from "./extractors";

/*
 * Resume extraction: source file (private object storage, never modified) →
 * text (pdf.js / mammoth) → deterministic section parsing → ResumeContent
 * validated with Zod → stored in resume_extractions. No AI is involved.
 *
 * File status: UPLOADED → PROCESSING → READY. If extraction fails the file
 * returns to UPLOADED (it stays a valid attachment); the failure is recorded on
 * the extraction (FAILED + failure code).
 *
 * SECURITY: every query filters on the file id AND the session user id.
 * Uploaded files are untrusted: parsing is bounded (size limit, page limit,
 * time limit) and extracted text is only ever stored and rendered as text.
 */

export interface ExtractionDeps {
  getStorage: () => StorageProvider;
}
const defaultDeps: ExtractionDeps = { getStorage: getStorageProvider };

/** A PROCESSING claim older than this is considered abandoned (e.g. server restart). */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;
const EXTRACTION_TIMEOUT_MS = 60 * 1000;
const MAX_STORED_TEXT_CHARS = 100_000;

const EXTRACTABLE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function isExtractable(mimeType: string): boolean {
  return EXTRACTABLE_MIME_TYPES.has(mimeType);
}

function fileNotFound() {
  return new NotFoundError("File not found.");
}

function parseFileId(fileId: unknown): string | null {
  const result = fileIdSchema.safeParse(fileId);
  return result.success ? result.data : null;
}

const warningsSchema = z.array(z.string()).catch([]);

type ExtractionRow = {
  uploadedFileId: string;
  status: ResumeExtractionView["status"];
  parserVersion: number;
  content: Prisma.JsonValue;
  warnings: Prisma.JsonValue;
  failureCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

const extractionSelect = {
  uploadedFileId: true,
  status: true,
  parserVersion: true,
  content: true,
  warnings: true,
  failureCode: true,
  startedAt: true,
  completedAt: true,
} as const;

function toView(row: ExtractionRow): ResumeExtractionView {
  // Stored JSON is re-validated on the way out; anything invalid is not exposed.
  const content = row.status === "READY" ? resumeContentSchema.safeParse(row.content) : null;
  const code = row.failureCode as ExtractionFailureCode | null;
  return {
    fileId: row.uploadedFileId,
    status: row.status,
    parserVersion: row.parserVersion,
    content: content?.success ? content.data : null,
    warnings: warningsSchema.parse(row.warnings ?? []),
    failureMessage:
      row.status === "FAILED"
        ? (EXTRACTION_FAILURES[code ?? "internal"] ?? EXTRACTION_FAILURES.internal)
        : null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** The extraction for the user's own file, or null if there is none. */
export async function getResumeExtraction(
  userId: string,
  fileId: unknown,
): Promise<ResumeExtractionView | null> {
  const id = parseFileId(fileId);
  if (!id) return null;
  const row = await getDb().resumeExtraction.findFirst({
    where: { uploadedFileId: id, userId, uploadedFile: { userId } },
    select: extractionSelect,
  });
  return row ? toView(row) : null;
}

/**
 * Claims the file for extraction (status PROCESSING) and returns the claim.
 * Run `runResumeExtraction` afterwards (typically after the response).
 * Re-claiming while a fresh run is in progress returns that run unchanged.
 */
export async function startResumeExtraction(
  userId: string,
  fileId: unknown,
): Promise<ResumeExtractionView> {
  const id = parseFileId(fileId);
  if (!id) throw fileNotFound();
  const db = getDb();

  const file = await db.uploadedFile.findFirst({
    where: { id, userId, status: { in: [...USABLE_FILE_STATUSES] } },
    select: { id: true, mimeType: true, extraction: { select: extractionSelect } },
  });
  if (!file) throw fileNotFound();
  if (!isExtractable(file.mimeType)) {
    throw new AppError({
      code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      status: 415,
      publicMessage: "Only PDF and DOCX resumes can be read right now.",
    });
  }

  const existing = file.extraction;
  if (
    existing?.status === "PROCESSING" &&
    Date.now() - existing.startedAt.getTime() < STALE_PROCESSING_MS
  ) {
    return toView(existing);
  }

  const claim = {
    status: "PROCESSING" as const,
    parserVersion: PARSER_VERSION,
    startedAt: new Date(),
    completedAt: null,
    rawText: null,
    content: Prisma.DbNull,
    warnings: Prisma.DbNull,
    failureCode: null,
  };
  const row = await db.resumeExtraction.upsert({
    where: { uploadedFileId: id },
    create: { uploadedFileId: id, userId, ...claim },
    update: claim,
    select: extractionSelect,
  });
  await db.uploadedFile.updateMany({
    where: { id, userId, status: { in: ["UPLOADED", "READY"] } },
    data: { status: "PROCESSING" },
  });
  return toView(row);
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extraction timed out")), ms);
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

/**
 * Performs a claimed extraction. Never throws: every failure is recorded as
 * FAILED with a code. Results are only written if this run still owns the
 * claim (same startedAt), so a stale run cannot overwrite a newer one.
 */
export async function runResumeExtraction(
  userId: string,
  fileId: string,
  deps: ExtractionDeps = defaultDeps,
): Promise<ResumeExtractionView | null> {
  const db = getDb();
  const file = await db.uploadedFile.findFirst({
    where: { id: fileId, userId },
    select: {
      storageKey: true,
      mimeType: true,
      extraction: { select: { status: true, startedAt: true } },
    },
  });
  const claimedAt = file?.extraction?.startedAt;
  if (!file || file.extraction?.status !== "PROCESSING" || !claimedAt) return null;

  const ownsClaim = {
    uploadedFileId: fileId,
    userId,
    status: "PROCESSING" as const,
    startedAt: claimedAt,
  };

  async function finish(
    data: Prisma.ResumeExtractionUpdateManyMutationInput,
    fileStatus: "READY" | "UPLOADED",
  ) {
    const { count } = await db.resumeExtraction.updateMany({
      where: ownsClaim,
      data: { ...data, completedAt: new Date() },
    });
    if (count > 0) {
      await db.uploadedFile.updateMany({
        where: { id: fileId, userId, status: "PROCESSING" },
        data: { status: fileStatus },
      });
    }
    return getResumeExtraction(userId, fileId);
  }

  const fail = (code: ExtractionFailureCode, error?: unknown) => {
    // Only the error type: parser messages can contain fragments of the document.
    if (error) logger.warn("Resume extraction failed", { fileId, code, reason: errorName(error) });
    return finish({ status: "FAILED", failureCode: code }, "UPLOADED");
  };

  try {
    let bytes: Uint8Array;
    try {
      bytes = await deps
        .getStorage()
        .getObject(file.storageKey as StorageKey, FILE_LIMITS.maxFileBytes);
    } catch (error) {
      return await fail("storage_error", error);
    }

    const extractor = extractorFor(file.mimeType);
    if (!extractor) return await fail("unreadable");

    let text: string;
    try {
      ({ text } = await withTimeout(
        extractor.extract(bytes, file.mimeType),
        EXTRACTION_TIMEOUT_MS,
      ));
    } catch (error) {
      return await fail("unreadable", error);
    }

    let parsed;
    try {
      parsed = parseResumeText(text);
    } catch (error) {
      return await fail(error instanceof NoExtractableTextError ? "no_text" : "internal", error);
    }

    return await finish(
      {
        status: "READY",
        rawText: text.slice(0, MAX_STORED_TEXT_CHARS),
        content: parsed.content as Prisma.InputJsonValue,
        warnings: parsed.warnings,
        failureCode: null,
      },
      "READY",
    );
  } catch (error) {
    logger.error("Unexpected resume extraction error", error, { fileId });
    try {
      return await fail("internal");
    } catch {
      return null;
    }
  }
}
