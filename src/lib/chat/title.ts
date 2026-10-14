import { DEFAULT_CONVERSATION_TITLE } from "./validation";

const DERIVED_TITLE_MAX_LENGTH = 60;

/**
 * Deterministic (non-AI) title from the first message: its first non-empty
 * line, whitespace-collapsed and cut at a word boundary. Users can rename it.
 */
export function deriveConversationTitle(firstMessage: string): string {
  const firstLine = firstMessage
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean);

  if (!firstLine) return DEFAULT_CONVERSATION_TITLE;
  if (firstLine.length <= DERIVED_TITLE_MAX_LENGTH) return firstLine;

  const cut = firstLine.slice(0, DERIVED_TITLE_MAX_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > DERIVED_TITLE_MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}
