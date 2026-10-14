import { ConversationList } from "@/features/chat/components/conversation-list";
import { ConversationListError } from "@/features/chat/components/conversation-list-states";
import type { ConversationSummary } from "@/lib/chat/types";
import { listConversations } from "@/server/chat/conversation-service";
import { logger } from "@/server/logger";

/**
 * Loads the signed-in user's recent conversations (metadata only). A failure
 * here degrades to an inline error instead of breaking the whole chat page.
 * `userId` comes from `requireUser()` in the layout, never from the client.
 */
export async function ConversationListLoader({ userId }: { userId: string }) {
  let conversations: ConversationSummary[];
  try {
    ({ items: conversations } = await listConversations(userId));
  } catch (error) {
    logger.error("Failed to load conversations", error);
    return <ConversationListError />;
  }
  return <ConversationList conversations={conversations} />;
}
