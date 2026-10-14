import { requireApiUser } from "@/lib/auth/session";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";
import { selectConversationTemplate } from "@/server/templates/template-service";

type Params = { conversationId: string };

/** Select the client template for this conversation: `{ templateId: string | null }`. */
export const PUT = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  const result = await selectConversationTemplate(
    user.id,
    (await params).conversationId,
    await readJsonBody(request),
  );
  return jsonOk(result);
});
