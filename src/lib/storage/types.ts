/**
 * Accepted STORAGE_PROVIDER ids: Cloudflare R2 (production) and "local" (a
 * folder on this computer, development only — refused in production). Another
 * S3-compatible or cloud provider would be added as a sibling under
 * `providers/` without touching application code.
 */
export const STORAGE_PROVIDER_IDS = ["r2", "local"] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDER_IDS)[number];

export const STORAGE_CATEGORIES = ["uploads", "templates", "generated"] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

/** An object key produced by `buildStorageKey` — never from raw user input. */
export type StorageKey = string & { readonly __brand: "StorageKey" };

export interface CreateUploadUrlParams {
  key: StorageKey;
  contentType: string;
  /** Exact byte length; signed into the URL so a different-sized body is rejected. */
  contentLength: number;
  expiresInSeconds: number;
}

/** A presigned request the browser performs itself (bytes never pass through our server). */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the browser must send unchanged — they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

export interface CreateDownloadUrlParams {
  expiresInSeconds: number;
  /** Suggested filename (Content-Disposition: attachment). Already sanitised. */
  downloadFilename: string;
  contentType: string;
}

/**
 * Private object storage for uploaded resumes, client templates and generated
 * documents. Buckets are never public; browsers only receive short-lived
 * presigned URLs for a single server-chosen key.
 */
export interface StorageProvider {
  readonly id: StorageProviderId;
  createUploadUrl(params: CreateUploadUrlParams): Promise<PresignedUpload>;
  /** Object metadata, or null if the object does not exist. */
  head(key: StorageKey): Promise<StoredObjectInfo | null>;
  /** The first `length` bytes (e.g. to check a file signature) without downloading the file. */
  readPrefix(key: StorageKey, length: number): Promise<Uint8Array>;
  /**
   * The whole object, for server-side processing. Throws if it is larger than
   * `maxBytes` (objects were size-verified at upload; this is defence in depth).
   */
  getObject(key: StorageKey, maxBytes: number): Promise<Uint8Array>;
  /**
   * Writes an object produced by the server (e.g. a generated DOCX). User
   * uploads never use this — browsers upload directly with a presigned PUT.
   */
  putObject(key: StorageKey, data: Uint8Array, contentType: string): Promise<void>;
  createDownloadUrl(
    key: StorageKey,
    params: CreateDownloadUrlParams,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: StorageKey): Promise<void>;
}
