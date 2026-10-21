import type { ErrorCode } from "@/lib/errors/app-error";
import type { FormattingJobView } from "@/lib/formatting/types";

import type { ChatMessage } from "./types";

/**
 * Wire format of `POST /api/conversations/:id/reply`: newline-delimited JSON,
 * one event per line. First a "formatting" event when the message asked for
 * formatting and the app started the job, then zero or more "delta" events (reply text as the model
 * writes it), then exactly one "done" (the saved message) or "error" (nothing
 * was saved). Errors found before streaming starts (not found, conflict, AI
 * not configured, rate limits) are ordinary JSON error responses instead.
 */
export type ReplyStreamEvent =
  | { type: "formatting"; job: FormattingJobView }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage | null }
  | { type: "error"; code: ErrorCode; message: string };

export const REPLY_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** Splits NDJSON text as it arrives; returns complete events and keeps the unfinished tail. */
export function splitReplyEvents(buffer: string): { events: ReplyStreamEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ReplyStreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as ReplyStreamEvent);
  }
  return { events, rest };
}
