const MAX_FILENAME_LENGTH = 120;

/**
 * Produces a safe display filename from untrusted input: strips any path
 * components, control characters and characters reserved on common
 * filesystems. Storage keys never use this value (see `lib/storage/keys.ts`).
 */
export function sanitizeFilename(input: string, fallback = "file"): string {
  const baseName = input.split(/[\\/]/).pop() ?? "";

  const cleaned = baseName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();

  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const extension = getFileExtension(cleaned);
  const suffix = extension ? `.${extension}` : "";
  return cleaned.slice(0, MAX_FILENAME_LENGTH - suffix.length) + suffix;
}

/** Lower-cased extension without the dot, or `null` if none / suspicious. */
export function getFileExtension(filename: string): string | null {
  const match = /\.([a-z0-9]{1,10})$/i.exec(filename);
  return match?.[1] ? match[1].toLowerCase() : null;
}
