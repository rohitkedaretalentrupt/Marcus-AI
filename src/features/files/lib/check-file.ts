import {
  fileKindOf,
  isSupportedMimeType,
  matchesFileSignature,
  mimeTypeForExtension,
  SIGNATURE_BYTES,
  type SupportedMimeType,
} from "@/lib/files/file-types";
import { FILE_LIMITS } from "@/lib/files/limits";
import { FILE_ERRORS } from "@/lib/files/validation";
import { getFileExtension } from "@/lib/utils/filename";

export type LocalFileCheck =
  { ok: true; contentType: SupportedMimeType } | { ok: false; error: string };

/** Types some browsers report when they don't know better (e.g. DOCX on Android). */
const GENERIC_TYPES = new Set(["", "application/octet-stream"]);

/**
 * Instant feedback before anything is uploaded: extension/type agreement,
 * size, and the file's leading bytes. The server repeats every check against
 * the stored object, so this is UX only.
 */
export async function checkFileLocally(file: File): Promise<LocalFileCheck> {
  const extension = getFileExtension(file.name);
  const contentType = extension ? mimeTypeForExtension(extension) : null;
  if (!contentType) return { ok: false, error: FILE_ERRORS.unsupported };
  if (!GENERIC_TYPES.has(file.type) && file.type !== contentType) {
    return { ok: false, error: FILE_ERRORS.unsupported };
  }
  if (file.size === 0) return { ok: false, error: FILE_ERRORS.empty };
  if (file.size > FILE_LIMITS.maxFileBytes) return { ok: false, error: FILE_ERRORS.tooLarge };

  const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  if (!matchesFileSignature(contentType, head)) {
    return { ok: false, error: FILE_ERRORS.unsupported };
  }
  return { ok: true, contentType };
}

/** Best guess from the name alone (for icons/previews before checks finish). */
export function guessKind(file: File) {
  const extension = getFileExtension(file.name);
  const type = extension ? mimeTypeForExtension(extension) : null;
  return type && isSupportedMimeType(type) ? fileKindOf(type) : null;
}
