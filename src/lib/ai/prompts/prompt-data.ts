/**
 * Helpers for embedding untrusted data (resume text, template content) in
 * prompts inside <tag>…</tag> blocks. The data must not be able to close the
 * block and pose as instructions, so "<" never appears in it literally.
 */

/** JSON with "<" escaped as < (still valid JSON, same value when parsed). */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Plain text with "<" replaced by a look-alike so no tag can be opened or closed. */
export function textForPrompt(text: string): string {
  return text.replace(/</g, "‹");
}
