"use client";

import { Button } from "@/components/ui/button";
import { ChatHeader } from "@/features/chat/components/chat-header";

export default function ConversationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <ChatHeader title="Conversation" />
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          Couldn&apos;t load this conversation.
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
        <Button onClick={reset}>Try again</Button>
      </div>
    </>
  );
}
