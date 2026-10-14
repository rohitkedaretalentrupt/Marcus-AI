import { requireApiUser } from "@/lib/auth/session";
import {
  deleteConversation,
  renameConversation,
  setConversationPinned,
} from "@/server/chat/conversation-service";
import { purgeDiscardedFiles } from "@/server/files/file-service";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string };

/** Rename: `{ title: string }`, or pin/unpin: `{ pinned: boolean }`. */
export const PATCH = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  const { conversationId } = await params;
  const body = await readJsonBody(request);
  const isPin = typeof body === "object" && body !== null && "pinned" in body;
  const conversation = isPin
    ? await setConversationPinned(user.id, conversationId, body)
    : await renameConversation(user.id, conversationId, body);
  return jsonOk(conversation);
});

export const DELETE = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const { conversationId } = await params;
  const { discardedFileIds } = await deleteConversation(user.id, conversationId);
  // Best-effort object removal; anything left over is handled by the cleanup job.
  await purgeDiscardedFiles(user.id, discardedFileIds);
  return new Response(null, { status: 204 });
});
