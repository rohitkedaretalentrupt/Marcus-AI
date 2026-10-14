import { requireApiUser } from "@/lib/auth/session";
import { startFormattingFromChat } from "@/server/formatting/formatting-service";
import { scheduleFormattingJob } from "@/server/formatting/schedule-formatting";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string };

/**
 * Format a resume from the chat: `{ resumeFileId?, templateId?, text? }`.
 * Uses a resume attached in this conversation (newest by default) and the
 * template given, named in `text`, or selected for the conversation. The job
 * runs after the response (202) and is shown as a card in the chat; an
 * identical job already running is returned instead (200).
 */
export const POST = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  enforceRateLimit(`format:${user.id}`, RATE_LIMITS.formattingCreatePerUser);
  const { job, created } = await startFormattingFromChat(
    user.id,
    (await params).conversationId,
    await readJsonBody(request),
  );
  if (created) scheduleFormattingJob(user.id, job.id);
  return jsonOk(job, { status: created ? 202 : 200 });
});
