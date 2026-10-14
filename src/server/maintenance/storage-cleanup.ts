import "server-only";

import { getDb } from "@/lib/db/client";
import { FILE_LIMITS } from "@/lib/files/limits";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import { logger } from "@/server/logger";

/*
 * Periodic object-storage cleanup (runs in-process, see startup.ts). Every
 * step is idempotent and safe to run from several instances at once:
 * deleting a missing object succeeds, and rows are only removed after their
 * object is gone.
 *
 * It never touches files a user can still see or use: sent attachments,
 * uploaded resumes, template sources and generated documents are only
 * removed through their explicit delete flows.
 *
 *   PENDING_UPLOAD older than the URL lifetime + 1 h → object (if the browser
 *     uploaded but never confirmed) and row deleted
 *   DELETED (object deletion failed earlier)        → object and row deleted
 *   FAILED (verification failed) older than 1 day   → object (already removed
 *     at rejection; idempotent) and row deleted
 */

export const CLEANUP_BATCH_SIZE = 200;
const HOUR = 60 * 60 * 1000;

export interface CleanupResult {
  abandonedUploads: number;
  deletedFiles: number;
  failedUploads: number;
  errors: number;
}

export async function runStorageCleanup(
  deps: { getStorage: () => StorageProvider } = { getStorage: getStorageProvider },
  now = new Date(),
): Promise<CleanupResult> {
  const result: CleanupResult = {
    abandonedUploads: 0,
    deletedFiles: 0,
    failedUploads: 0,
    errors: 0,
  };
  const storage = deps.getStorage();
  const db = getDb();

  const stages = [
    {
      key: "abandonedUploads" as const,
      where: {
        status: "PENDING_UPLOAD" as const,
        createdAt: { lt: new Date(now.getTime() - FILE_LIMITS.uploadUrlTtlSeconds * 1000 - HOUR) },
      },
    },
    {
      key: "deletedFiles" as const,
      where: {
        status: "DELETED" as const,
        updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) },
      },
    },
    {
      key: "failedUploads" as const,
      where: { status: "FAILED" as const, updatedAt: { lt: new Date(now.getTime() - 24 * HOUR) } },
    },
  ];

  for (const stage of stages) {
    const files = await db.uploadedFile.findMany({
      // Never a file that belongs to a message or a template.
      where: { ...stage.where, attachment: null, template: null },
      select: { id: true, storageKey: true, status: true },
      orderBy: { createdAt: "asc" },
      take: CLEANUP_BATCH_SIZE,
    });
    for (const file of files) {
      try {
        await storage.delete(file.storageKey as StorageKey);
        const { count } = await db.uploadedFile.deleteMany({
          where: { id: file.id, status: file.status, attachment: null, template: null },
        });
        result[stage.key] += count;
      } catch (error) {
        result.errors++;
        logger.warn("Storage cleanup could not remove a file; will retry", {
          fileId: file.id,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
  return result;
}

const CLEANUP_INTERVAL_MS = HOUR;
const FIRST_RUN_DELAY_MS = 60_000;

/** Starts the hourly cleanup once per process (no-op if already started). */
export function scheduleStorageCleanup(): void {
  const flag = globalThis as { __storageCleanupScheduled?: boolean };
  if (flag.__storageCleanupScheduled) return;
  flag.__storageCleanupScheduled = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runStorageCleanup();
      if (Object.values(result).some((count) => count > 0)) {
        logger.info("Storage cleanup finished", { ...result });
      }
    } catch (error) {
      logger.error("Storage cleanup failed", error);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref();
  setInterval(tick, CLEANUP_INTERVAL_MS).unref();
}
