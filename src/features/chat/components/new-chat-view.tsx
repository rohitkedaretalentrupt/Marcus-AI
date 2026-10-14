"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ApiRequestError } from "@/lib/api/client";
import { conversationPath } from "@/lib/chat/routes";
import { looksLikeFormatRequest } from "@/lib/formatting/chat-request";
import type { FileSummary } from "@/lib/files/types";

import { composerFootnote, SEND_FAILED_MESSAGE } from "../lib/copy";
import { createConversation } from "../lib/chat-api";
import { ChatComposer } from "./chat-composer";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatHeader } from "./chat-header";
import { FormAlert } from "@/components/ui/form-alert";

/**
 * A chat that does not exist yet. The conversation is created together with
 * the first message (one atomic request), so abandoned "New chat" clicks never
 * leave empty conversations behind.
 */
export function NewChatView({ aiEnabled }: { aiEnabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSend(content: string, attachments: FileSummary[]): Promise<boolean> {
    setError(null);
    try {
      const { conversation } = await createConversation(
        content,
        attachments.map((file) => file.id),
      );
      // The conversation page sends the reply request / starts formatting once it opens.
      const params = new URLSearchParams();
      if (aiEnabled) params.set("respond", "1");
      if (looksLikeFormatRequest(content)) params.set("format", "1");
      const query = params.toString();
      const path = conversationPath(conversation.id);
      router.push(query ? `${path}?${query}` : path);
      router.refresh();
      return true;
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError && caught.status === 400
          ? caught.displayMessage
          : SEND_FAILED_MESSAGE,
      );
      return false; // keep the text so nothing the user typed is lost
    }
  }

  function handleSuggestion(prompt: string) {
    setDraft(prompt);
    inputRef.current?.focus();
  }

  return (
    <>
      <ChatHeader title="New chat" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ChatEmptyState onSuggestion={handleSuggestion} />
      </div>
      <div className="shrink-0">
        {error ? (
          <div className="mx-auto w-full max-w-3xl px-3 md:px-4">
            <FormAlert message={error} />
          </div>
        ) : null}
        <ChatComposer
          value={draft}
          onValueChange={setDraft}
          onSend={handleSend}
          inputRef={inputRef}
          footnote={composerFootnote(aiEnabled)}
        />
      </div>
    </>
  );
}
