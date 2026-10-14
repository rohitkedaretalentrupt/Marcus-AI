/**
 * Provider-neutral AI failure. `message` is for logs and must never contain
 * API keys, prompts or model output.
 */
export const AI_ERROR_KINDS = [
  "timeout",
  "rate_limited",
  "auth",
  "unavailable",
  "bad_request",
  "invalid_response",
  "content_filter",
] as const;
export type AIErrorKind = (typeof AI_ERROR_KINDS)[number];

export class AIProviderError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

/**
 * Extracts a JSON value from model text: plain JSON, a ```json fenced block,
 * or the outermost {...} span. Throws if none parses.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  const candidates = [fenced ?? trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new AIProviderError("invalid_response", "Model output was not valid JSON");
}
