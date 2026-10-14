import { Suspense, type ReactNode } from "react";

import { CurrentUserProvider } from "@/features/auth/components/current-user-provider";
import { ChatShell } from "@/features/chat/components/chat-shell";
import { ConversationListSkeleton } from "@/features/chat/components/conversation-list-states";
import { requireUser } from "@/lib/auth/session";

import { ConversationListLoader } from "./_components/conversation-list-loader";

/**
 * Authenticated chat area. The conversation list streams in behind a
 * skeleton so the chat panel is usable immediately.
 */
export default async function ChatLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <CurrentUserProvider user={user}>
      <ChatShell
        conversationList={
          <Suspense fallback={<ConversationListSkeleton />}>
            <ConversationListLoader userId={user.id} />
          </Suspense>
        }
      >
        {children}
      </ChatShell>
    </CurrentUserProvider>
  );
}
