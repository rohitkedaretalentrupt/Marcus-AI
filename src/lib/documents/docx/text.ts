/**
 * Text helpers shared by the DOCX renderer and the DOCX validator, so the
 * validator looks for exactly the text the renderer was asked to write.
 */

// Characters that are not allowed in XML 1.0 (and would corrupt the package).
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Removes XML-invalid characters and turns tabs into spaces (keeps surrounding spaces). */
export function stripInvalidChars(text: string): string {
  return text.replace(XML_INVALID, "").replace(/\t/g, " ");
}

/** `stripInvalidChars` + trim. */
export function cleanText(text: string): string {
  // "harlan bakeries , avon indiana" → "harlan bakeries, avon indiana"; runs of spaces → one.
  return stripInvalidChars(text)
    .replace(/ {2,}/g, " ")
    .replace(/ +([,;])/g, "$1")
    .trim();
}

/** Splits multi-line text into paragraphs (blank-line or line-break separated). */
export function toParagraphs(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map(cleanText)
    .filter((line) => line.length > 0);
}

/** Whitespace-insensitive form used to compare expected and rendered text. */
export function comparable(text: string): string {
  return cleanText(text).replace(/\s+/g, " ");
}

/** Visible text for a link: the URL without scheme, "www." or a trailing slash. */
export function linkDisplayText(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/** Only web links are rendered as hyperlinks (never javascript:, data:, file:, …). */
export function isSafeWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Words that end with a full stop without ending a sentence. */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "inc",
  "ltd",
  "co",
  "corp",
  "llc",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "jr",
  "sr",
  "no",
  "approx",
  "dept",
  "est",
  "fig",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "u.s",
  "u.k",
]);

/**
 * Splits running text into sentences for bullet points, keeping every word
 * exactly as written: lines stay separate, and a line is split only after
 * ".", "!" or "?" followed by a space and a capital letter or digit — not
 * after common abbreviations ("e.g.", "Inc.") or initials ("J. Smith").
 */
export function toSentences(text: string | undefined): string[] {
  const sentences: string[] = [];
  for (const line of toParagraphs(text)) {
    let start = 0;
    const boundary = /[.!?]["')\]]?\s+(?=[\p{Lu}\p{N}])/gu;
    for (let match = boundary.exec(line); match; match = boundary.exec(line)) {
      const before = line.slice(start, match.index);
      const lastWord = /(\S+)$/.exec(before)?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(lastWord) || /^\p{L}$/u.test(lastWord)) continue;
      const end = match.index + match[0].trimEnd().length;
      sentences.push(line.slice(start, end).trim());
      start = match.index + match[0].length;
    }
    const rest = line.slice(start).trim();
    if (rest) sentences.push(rest);
  }
  return sentences;
}
