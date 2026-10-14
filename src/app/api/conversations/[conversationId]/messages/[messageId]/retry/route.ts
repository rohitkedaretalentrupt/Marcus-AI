import { requireApiUser } from "@/lib/auth/session";
import { prepareRetry } from "@/server/chat/conversation-service";
import { purgeDiscardedFiles } from "@/server/files/file-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string; messageId: string };

/**
 * Retry a task: removes what came after the user message (or the assistant
 * reply being regenerated) and returns the user message to run again. The
 * client then requests the reply and/or formatting, as for a new message.
 */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const { conversationId, messageId } = await params;
  const { message, discardedFileIds } = await prepareRetry(user.id, conversationId, messageId);
  await purgeDiscardedFiles(user.id, discardedFileIds);
  return jsonOk(message);
});
