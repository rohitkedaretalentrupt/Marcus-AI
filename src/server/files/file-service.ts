import "server-only";

import { randomBytes } from "node:crypto";

import { getDb } from "@/lib/db/client";
import { AppError, ERROR_CODES, NotFoundError, RateLimitError } from "@/lib/errors/app-error";
import {
  getFileType,
  matchesFileSignature,
  SIGNATURE_BYTES,
  type SupportedMimeType,
} from "@/lib/files/file-types";
import { FILE_LIMITS } from "@/lib/files/limits";
import {
  USABLE_FILE_STATUSES,
  type FileSummary,
  type UploadAuthorization,
} from "@/lib/files/types";
import { fileIdSchema, uploadRequestSchema } from "@/lib/files/validation";
import { buildStorageKey } from "@/lib/storage/keys";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import { logger } from "@/server/logger";

import { fileSummarySelect, toFileSummary } from "./file-summary";

/*
 * Upload lifecycle: request (PENDING_UPLOAD + presigned PUT) → the browser
 * uploads straight to object storage → confirm (server verifies the stored
 * object) → UPLOADED → attachable. Bytes never pass through this server.
 *
 * SECURITY: every function takes the user id from the session and every
 * query filters on BOTH the file id and that user id. Storage keys are always
 * generated here; nothing the client sends is used to build one.
 *
 * Uploaded files are NOT malware scanned. The pipeline leaves room for it:
 * UPLOADED → (scan) → PROCESSING → READY in a later phase.
 */

export interface FileServiceDeps {
  /** Resolved lazily so database-only paths never require storage configuration. */
  getStorage: () => StorageProvider;
}

const defaultDeps: FileServiceDeps = { getStorage: getStorageProvider };

export class UploadVerificationError extends AppError {
  constructor(reason: string) {
    super({
      code: ERROR_CODES.UPLOAD_NOT_VERIFIED,
      status: 422,
      publicMessage: "Could not verify the uploaded file. Please try again.",
      message: `Upload verification failed: ${reason}`,
    });
  }
}

function fileNotFound(): NotFoundError {
  return new NotFoundError("File not found.");
}

function parseFileId(fileId: unknown): string | null {
  const result = fileIdSchema.safeParse(fileId);
  return result.success ? result.data : null;
}

/** 32 hex chars: unguessable, and safe as a storage key segment. */
function generateFileId(): string {
  return randomBytes(16).toString("hex");
}

/** Validates metadata, reserves a storage key and returns a short-lived presigned PUT. */
export async function requestUpload(
  userId: string,
  input: unknown,
  deps: FileServiceDeps = defaultDeps,
): Promise<UploadAuthorization> {
  const request = parseOrThrow(uploadRequestSchema, input);
  const storage = deps.getStorage(); // fail before creating rows if storage is unavailable
  const db = getDb();

  const openUploads = await db.uploadedFile.count({
    where: {
      userId,
      status: "PENDING_UPLOAD",
      createdAt: { gt: new Date(Date.now() - FILE_LIMITS.uploadUrlTtlSeconds * 1000) },
    },
  });
  if (openUploads >= FILE_LIMITS.maxPendingUploadsPerUser) {
    throw new RateLimitError(
      "Too many uploads in progress. Wait for them to finish and try again.",
    );
  }

  const id = generateFileId();
  const storageKey = buildStorageKey({
    userId,
    category: request.purpose === "template" ? "templates" : "uploads",
    objectId: id,
    // Canonical extension for the verified type — never the user's.
    extension: getFileType(request.contentType).extensions[0]!,
  });

  const row = await db.uploadedFile.create({
    data: {
      id,
      userId,
      originalFilename: request.filename,
      storageKey,
      mimeType: request.contentType,
      sizeBytes: request.sizeBytes,
      purpose: request.purpose === "template" ? "TEMPLATE" : "ATTACHMENT",
    },
    select: fileSummarySelect,
  });

  try {
    const upload = await storage.createUploadUrl({
      key: storageKey,
      contentType: request.contentType,
      contentLength: request.sizeBytes,
      expiresInSeconds: FILE_LIMITS.uploadUrlTtlSeconds,
    });
    return {
      file: toFileSummary(row),
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
    };
  } catch (error) {
    await db.uploadedFile.updateMany({
      where: { id, userId },
      data: { status: "FAILED", failureReason: "presign_failed" },
    });
    throw error;
  }
}

/** Strips parameters (e.g. "; charset=…") and case for comparison. */
function normaliseContentType(value: string | null): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Marks an upload UPLOADED only after verifying the stored object itself:
 * it exists, its size equals the declared size (and the limit), its stored
 * content type matches, and its leading bytes match the format's signature.
 * On any mismatch the object is deleted and the file marked FAILED.
 */
export async function confirmUpload(
  userId: string,
  fileId: unknown,
  deps: FileServiceDeps = defaultDeps,
): Promise<FileSummary> {
  const id = parseFileId(fileId);
  if (!id) throw fileNotFound();
  const db = getDb();

  const file = await db.uploadedFile.findFirst({
    where: { id, userId },
    select: { ...fileSummarySelect, storageKey: true },
  });
  if (!file) throw fileNotFound();
  if ((USABLE_FILE_STATUSES as readonly string[]).includes(file.status)) {
    return toFileSummary(file); // idempotent
  }
  if (file.status !== "PENDING_UPLOAD") {
    throw new UploadVerificationError(`file is ${file.status}`);
  }

  const storage = deps.getStorage();
  const key = file.storageKey as StorageKey;
  const mimeType = file.mimeType as SupportedMimeType;

  const reject = async (reason: string): Promise<never> => {
    try {
      await storage.delete(key);
    } catch (error) {
      logger.error("Failed to delete rejected upload object", error, { fileId: id });
    }
    await db.uploadedFile.updateMany({
      where: { id, userId, status: "PENDING_UPLOAD" },
      data: { status: "FAILED", failureReason: reason },
    });
    throw new UploadVerificationError(reason);
  };

  const object = await storage.head(key);
  if (!object) return reject("object_missing");
  if (object.sizeBytes !== file.sizeBytes || object.sizeBytes > FILE_LIMITS.maxFileBytes) {
    return reject("size_mismatch");
  }
  if (normaliseContentType(object.contentType) !== mimeType) return reject("type_mismatch");
  if (!matchesFileSignature(mimeType, await storage.readPrefix(key, SIGNATURE_BYTES))) {
    return reject("signature_mismatch");
  }

  await db.uploadedFile.updateMany({
    where: { id, userId, status: "PENDING_UPLOAD" },
    data: { status: "UPLOADED", uploadedAt: new Date() },
  });
  const updated = await db.uploadedFile.findFirst({
    where: { id, userId },
    select: fileSummarySelect,
  });
  if (!updated) throw fileNotFound();
  return toFileSummary(updated);
}

/**
 * Removes the user's own file that has not been sent in a message (e.g. the
 * user removed it from the composer). Sent attachments can only be removed by
 * deleting their conversation.
 */
export async function discardUpload(
  userId: string,
  fileId: unknown,
  deps: FileServiceDeps = defaultDeps,
): Promise<void> {
  const id = parseFileId(fileId);
  if (!id) throw fileNotFound();

  const file = await getDb().uploadedFile.findFirst({
    where: { id, userId },
    select: { id: true, attachment: { select: { id: true } }, template: { select: { id: true } } },
  });
  if (!file) throw fileNotFound();
  if (file.template) {
    // Deleting the file would silently cascade to the template; use template deletion.
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      publicMessage: "This file belongs to a client template. Delete the template instead.",
    });
  }
  if (file.attachment) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      publicMessage: "This file is part of a sent message.",
    });
  }

  await purgeDiscardedFiles(userId, [id], deps);
}

/**
 * Marks files DELETED, deletes their objects, then removes the rows. Never
 * throws: a failed object deletion leaves the row DELETED for the cleanup job
 * (deletes are idempotent, so retrying is safe).
 */
export async function purgeDiscardedFiles(
  userId: string,
  fileIds: readonly string[],
  deps: FileServiceDeps = defaultDeps,
): Promise<void> {
  if (fileIds.length === 0) return;
  const db = getDb();

  try {
    const files = await db.uploadedFile.findMany({
      where: { id: { in: [...fileIds] }, userId, attachment: null },
      select: { id: true, storageKey: true },
    });
    await db.uploadedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) }, userId },
      data: { status: "DELETED" },
    });

    const storage = deps.getStorage();
    for (const file of files) {
      try {
        await storage.delete(file.storageKey as StorageKey);
        await db.uploadedFile.deleteMany({ where: { id: file.id, userId, attachment: null } });
      } catch (error) {
        logger.error("Failed to purge file object; left for cleanup", error, { fileId: file.id });
      }
    }
  } catch (error) {
    logger.error("Failed to purge discarded files; left for cleanup", error, {
      count: fileIds.length,
    });
  }
}

/** A short-lived signed GET URL for the user's own, verified file. */
export async function createDownloadUrl(
  userId: string,
  fileId: unknown,
  deps: FileServiceDeps = defaultDeps,
): Promise<{ url: string; expiresAt: string }> {
  const id = parseFileId(fileId);
  if (!id) throw fileNotFound();

  const file = await getDb().uploadedFile.findFirst({
    where: { id, userId, status: { in: [...USABLE_FILE_STATUSES] } },
    select: { storageKey: true, originalFilename: true, mimeType: true },
  });
  if (!file) throw fileNotFound();

  const { url, expiresAt } = await deps
    .getStorage()
    .createDownloadUrl(file.storageKey as StorageKey, {
      expiresInSeconds: FILE_LIMITS.downloadUrlTtlSeconds,
      downloadFilename: file.originalFilename,
      contentType: file.mimeType,
    });
  return { url, expiresAt: expiresAt.toISOString() };
}
