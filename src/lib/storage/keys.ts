import { STORAGE_CATEGORIES, type StorageCategory, type StorageKey } from "./types";

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SAFE_EXTENSION = /^[a-z0-9]{1,10}$/;

interface BuildStorageKeyParams {
  userId: string;
  category: StorageCategory;
  /** Server-generated id (e.g. the UploadedFile row id). */
  objectId: string;
  extension: string;
}

/**
 * Builds a tenant-scoped key: `users/{userId}/{category}/{objectId}.{ext}`.
 *
 * Uploaded filenames are never part of the key — that prevents path traversal,
 * collisions and leaking personal data through object names.
 */
export function buildStorageKey({
  userId,
  category,
  objectId,
  extension,
}: BuildStorageKeyParams): StorageKey {
  if (!SAFE_SEGMENT.test(userId)) throw new Error("Invalid userId for storage key");
  if (!SAFE_SEGMENT.test(objectId)) throw new Error("Invalid objectId for storage key");
  if (!STORAGE_CATEGORIES.includes(category)) throw new Error("Invalid storage category");

  const ext = extension.toLowerCase();
  if (!SAFE_EXTENSION.test(ext)) throw new Error("Invalid extension for storage key");

  return `users/${userId}/${category}/${objectId}.${ext}` as StorageKey;
}

/** Ownership check before serving an object to a user. */
export function isKeyOwnedBy(key: StorageKey, userId: string): boolean {
  return key.startsWith(`users/${userId}/`);
}
