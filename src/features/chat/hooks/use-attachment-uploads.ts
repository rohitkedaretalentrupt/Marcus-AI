import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError } from "@/lib/api/client";
import { ERROR_CODES } from "@/lib/errors/app-error";
import type { FileKind } from "@/lib/files/file-types";
import { FILE_LIMITS, formatFileSize } from "@/lib/files/limits";
import type { FileSummary } from "@/lib/files/types";

import { checkFileLocally, guessKind } from "@/features/files/lib/check-file";
import {
  confirmUpload,
  discardUpload,
  requestUpload,
  uploadToStorage,
} from "@/features/files/lib/file-api";

export type AttachmentPhase =
  "checking" | "preparing" | "uploading" | "verifying" | "ready" | "failed";

export interface ComposerAttachment {
  localId: string;
  file: File;
  kind: FileKind | null;
  /** Local object URL for image thumbnails (never uploaded or shared). */
  previewUrl: string | null;
  phase: AttachmentPhase;
  /** 0–1 while uploading when the browser reports progress; otherwise null. */
  progress: number | null;
  error: string | null;
  retryable: boolean;
  /** Server file id once an upload has been authorized. */
  fileId: string | null;
  /** Verified server metadata once confirmed. */
  summary: FileSummary | null;
}

const UPLOAD_FAILED = "Upload failed. Please try again.";

function describeFailure(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof ApiRequestError) {
    if (error.code === ERROR_CODES.UPLOAD_NOT_VERIFIED) {
      return { message: "Could not verify the uploaded file.", retryable: true };
    }
    if (error.status === 400) return { message: error.displayMessage, retryable: false };
    if (error.status === 429 || error.status === 503)
      return { message: error.message, retryable: true };
  }
  return { message: UPLOAD_FAILED, retryable: true };
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Composer attachment state: validates, uploads directly to storage with real
 * progress, confirms server-side, and supports remove/retry. Removing an
 * uploaded-but-unsent file asks the server to discard it.
 */
export function useAttachmentUploads() {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [limitError, setLimitError] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const latestItems = useRef<ComposerAttachment[]>([]);

  useEffect(() => {
    latestItems.current = items;
  }, [items]);

  const update = useCallback((localId: string, patch: Partial<ComposerAttachment>) => {
    setItems((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }, []);

  const run = useCallback(
    async (localId: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);
      update(localId, { phase: "checking", error: null, progress: null, fileId: null });

      try {
        const check = await checkFileLocally(file);
        if (!check.ok) {
          update(localId, { phase: "failed", error: check.error, retryable: false });
          return;
        }

        update(localId, { phase: "preparing" });
        const { file: created, upload } = await requestUpload({
          filename: file.name,
          contentType: check.contentType,
          sizeBytes: file.size,
        });
        if (controller.signal.aborted) return;

        update(localId, { phase: "uploading", progress: 0, fileId: created.id });
        await uploadToStorage(upload, file, {
          signal: controller.signal,
          onProgress: (progress) => update(localId, { progress }),
        });

        update(localId, { phase: "verifying", progress: null });
        const summary = await confirmUpload(created.id);
        update(localId, { phase: "ready", summary });
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) return;
        const { message, retryable } = describeFailure(error);
        update(localId, { phase: "failed", error: message, retryable, progress: null });
      } finally {
        controllers.current.delete(localId);
      }
    },
    [update],
  );

  function addFiles(files: File[]) {
    setLimitError(null);
    const room = FILE_LIMITS.maxAttachmentsPerMessage - items.length;
    let totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    const accepted: ComposerAttachment[] = [];

    for (const file of files) {
      if (accepted.length >= room) {
        setLimitError(
          `You can attach up to ${FILE_LIMITS.maxAttachmentsPerMessage} files per message.`,
        );
        break;
      }
      if (totalBytes + file.size > FILE_LIMITS.maxTotalAttachmentBytes) {
        setLimitError(
          `Attachments can total at most ${formatFileSize(FILE_LIMITS.maxTotalAttachmentBytes)} per message.`,
        );
        break;
      }
      totalBytes += file.size;
      const kind = guessKind(file);
      accepted.push({
        localId: crypto.randomUUID(),
        file,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
        phase: "checking",
        progress: null,
        error: null,
        retryable: false,
        fileId: null,
        summary: null,
      });
    }

    if (accepted.length === 0) return;
    setItems((current) => [...current, ...accepted]);
    for (const item of accepted) void run(item.localId, item.file);
  }

  function remove(localId: string) {
    const item = items.find((candidate) => candidate.localId === localId);
    if (!item) return;
    controllers.current.get(localId)?.abort();
    // Not sent yet: release the stored object instead of leaving it behind.
    if (item.fileId) void discardUpload(item.fileId).catch(() => {});
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems((current) => current.filter((candidate) => candidate.localId !== localId));
    setLimitError(null);
  }

  function retry(localId: string) {
    const item = items.find((candidate) => candidate.localId === localId);
    if (!item || item.phase !== "failed" || !item.retryable) return;
    // The failed attempt's record is discarded; the retry gets a fresh upload.
    if (item.fileId) void discardUpload(item.fileId).catch(() => {});
    void run(localId, item.file);
  }

  /** After a successful send: the files now belong to the message, so nothing is discarded. */
  function clearSent() {
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    // Cleared immediately so an unmount right after sending (e.g. navigating to
    // the new conversation) never tries to discard files that were just sent.
    latestItems.current = [];
    setItems([]);
    setLimitError(null);
  }

  // Leaving the page/conversation: stop transfers, free previews and discard
  // unsent uploads (anything missed is removed by the stale-upload cleanup).
  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      for (const item of latestItems.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.fileId) void discardUpload(item.fileId).catch(() => {});
      }
    };
  }, []);

  const readyFiles = useMemo(
    () => items.flatMap((item) => (item.phase === "ready" && item.summary ? [item.summary] : [])),
    [items],
  );

  return {
    items,
    limitError,
    addFiles,
    remove,
    retry,
    clearSent,
    readyFiles,
    isBusy: items.some((item) => item.phase !== "ready" && item.phase !== "failed"),
    hasFailed: items.some((item) => item.phase === "failed"),
  };
}
