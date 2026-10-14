import { requireApiUser } from "@/lib/auth/session";
import { sendUserMessage } from "@/server/chat/conversation-service";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string };

/**
 * Send a user message: `{ content: string }`. Only persists the message —
 * no AI provider is called (assistant replies arrive in a later phase).
 */
export const POST = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  const { conversationId } = await params;
  const message = await sendUserMessage(user.id, conversationId, await readJsonBody(request));
  return jsonOk(message, { status: 201 });
});
