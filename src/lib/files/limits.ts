const MB = 1024 * 1024;

/**
 * Upload limits (shared by client and server; the server enforces them).
 * Change here to adjust — every check and every user-facing message reads
 * these values.
 */
export const FILE_LIMITS = {
  maxFileBytes: 20 * MB,
  maxAttachmentsPerMessage: 5,
  maxTotalAttachmentBytes: 50 * MB,
  /** Presigned PUT lifetime. Short: the browser starts uploading immediately. */
  uploadUrlTtlSeconds: 10 * 60,
  /** Signed GET lifetime for downloads. */
  downloadUrlTtlSeconds: 5 * 60,
  /** Unconfirmed uploads a user may have open at once (abuse guard). */
  maxPendingUploadsPerUser: 10,
} as const;

/** Human-readable size, e.g. "2.4 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}
