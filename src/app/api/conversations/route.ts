import { requireApiUser } from "@/lib/auth/session";
import { createConversation } from "@/server/chat/conversation-service";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

/** Create a conversation, optionally with its first message: `{ message?: string }`. */
export const POST = withErrorHandling(async (request) => {
  const user = await requireApiUser();
  const result = await createConversation(user.id, await readJsonBody(request));
  return jsonOk(result, { status: 201 });
});
