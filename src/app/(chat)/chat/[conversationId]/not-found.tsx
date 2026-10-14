import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ChatHeader } from "@/features/chat/components/chat-header";
import { NEW_CHAT_PATH } from "@/lib/chat/routes";

/** Same response whether the conversation never existed or belongs to someone else. */
export default function ConversationNotFound() {
  return (
    <>
      <ChatHeader title="Conversation not found" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This conversation doesn&apos;t exist or is no longer available.
        </p>
        <Button asChild>
          <Link href={NEW_CHAT_PATH}>Start a new chat</Link>
        </Button>
      </div>
    </>
  );
}
