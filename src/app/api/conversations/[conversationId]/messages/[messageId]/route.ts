import { requireApiUser } from "@/lib/auth/session";
import { deleteMessage, editMessage } from "@/server/chat/conversation-service";
import { purgeDiscardedFiles } from "@/server/files/file-service";
import { discardConversationJobsAfter } from "@/server/formatting/formatting-service";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string; messageId: string };

/**
 * Edit one of your own messages: `{ content }`. Everything after it is
 * removed (like ChatGPT); the client then asks for a new reply / formatting.
 */
export const PATCH = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  const { conversationId, messageId } = await params;
  const { message, discardedFileIds } = await editMessage(
    user.id,
    conversationId,
    messageId,
    await readJsonBody(request),
  );
  await purgeDiscardedFiles(user.id, discardedFileIds);
  // Resumes generated after the edited message are removed with everything else after it.
  await discardConversationJobsAfter(user.id, conversationId, new Date(message.createdAt));
  return jsonOk(message);
});

/** Delete a single message (and its attachments). */
export const DELETE = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const { conversationId, messageId } = await params;
  const { discardedFileIds } = await deleteMessage(user.id, conversationId, messageId);
  await purgeDiscardedFiles(user.id, discardedFileIds);
  return new Response(null, { status: 204 });
});
