import "server-only";

import { AppError } from "@/lib/errors/app-error";
import type { FormattingJobView } from "@/lib/formatting/types";
import { startFormattingFromChat } from "@/server/formatting/formatting-service";
import { startFormattingJobNow } from "@/server/formatting/schedule-formatting";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { logger } from "@/server/logger";

/** What the app did about a chat message that asked for formatting. */
export type ChatFormattingOutcome =
  { status: "started"; job: FormattingJobView } | { status: "not_started"; reason: string };

/**
 * Starts formatting for a chat message that asked for it (same rules as
 * `POST …/format`) and reports the outcome instead of throwing, so the
 * assistant's reply can say exactly what happened. The job starts at once.
 */
export async function startChatFormatting(
  userId: string,
  conversationId: string,
  text: string,
  previousReply: string | null,
): Promise<ChatFormattingOutcome> {
  try {
    enforceRateLimit(`format:${userId}`, RATE_LIMITS.formattingCreatePerUser);
    const { job, created } = await startFormattingFromChat(userId, conversationId, {
      text: text.slice(0, 4000),
      ...(previousReply ? { previousReply: previousReply.slice(0, 20_000) } : {}),
    });
    if (created) startFormattingJobNow(userId, job.id);
    return { status: "started", job };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: "not_started", reason: error.issues?.[0]?.message ?? error.publicMessage };
    }
    logger.error("Starting formatting from a chat reply failed", error, { conversationId });
    return { status: "not_started", reason: "Formatting couldn't be started. Please try again." };
  }
}
