import { apiErrorFrom, apiFetch, ApiRequestError } from "@/lib/api/client";
import { splitReplyEvents } from "@/lib/chat/reply-stream";
import { CONVERSATIONS_API, conversationApi, conversationMessagesApi } from "@/lib/chat/routes";
import type { ChatMessage, ConversationSummary } from "@/lib/chat/types";
import type { FormattingJobView } from "@/lib/formatting/types";

/** Browser calls to the conversation API. The server derives the user from the session. */

export function createConversation(message: string, attachmentFileIds: string[] = []) {
  return apiFetch<{ conversation: ConversationSummary; message: ChatMessage | null }>(
    CONVERSATIONS_API,
    { method: "POST", body: { message, attachmentFileIds } },
  );
}

export function sendMessage(conversationId: string, content: string, attachmentFileIds: string[]) {
  return apiFetch<ChatMessage>(conversationMessagesApi(conversationId), {
    method: "POST",
    body: { content, attachmentFileIds },
  });
}

export function renameConversation(conversationId: string, title: string) {
  return apiFetch<ConversationSummary>(conversationApi(conversationId), {
    method: "PATCH",
    body: { title },
  });
}

export function deleteConversation(conversationId: string) {
  return apiFetch<void>(conversationApi(conversationId), { method: "DELETE" });
}

export const REPLY_INTERRUPTED_MESSAGE = "The reply was interrupted. Please try again.";

/**
 * Asks the server for the assistant's reply to the newest user message and
 * reads it as it streams: `onDelta` gets each piece of text as the model
 * writes it. Resolves with the saved message once the reply is complete.
 * Aborting `signal` stops generating (the server saves nothing) and rejects
 * with the abort error. Other failures reject with an ApiRequestError.
 */
export async function streamReply(
  conversationId: string,
  {
    signal,
    onDelta,
    onFormatting,
  }: {
    signal: AbortSignal;
    onDelta: (text: string) => void;
    /** The message asked for formatting and the server started the job. */
    onFormatting?: (job: FormattingJobView) => void;
  },
): Promise<ChatMessage | null> {
  let response: Response;
  try {
    response = await fetch(`${conversationApi(conversationId)}/reply`, { method: "POST", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiRequestError(0, "NETWORK", "Couldn't reach the server. Check your connection.");
  }
  if (!response.ok) throw await apiErrorFrom(response);
  if (!response.body) throw new ApiRequestError(0, "NETWORK", REPLY_INTERRUPTED_MESSAGE);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiRequestError(0, "NETWORK", REPLY_INTERRUPTED_MESSAGE);
      }
      if (chunk.done) break;
      const { events, rest } = splitReplyEvents(buffer + chunk.value);
      buffer = rest;
      for (const event of events) {
        if (event.type === "delta") onDelta(event.text);
        else if (event.type === "formatting") onFormatting?.(event.job);
        else if (event.type === "done") return event.message;
        else throw new ApiRequestError(502, event.code, event.message);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  // The connection closed before the server said the reply was done.
  throw new ApiRequestError(0, "NETWORK", REPLY_INTERRUPTED_MESSAGE);
}

export function setConversationPinned(conversationId: string, pinned: boolean) {
  return apiFetch<ConversationSummary>(conversationApi(conversationId), {
    method: "PATCH",
    body: { pinned },
  });
}

const messageApi = (conversationId: string, messageId: string) =>
  `${conversationMessagesApi(conversationId)}/${encodeURIComponent(messageId)}`;

/** Edit your own message; everything after it is removed. */
export function editMessage(conversationId: string, messageId: string, content: string) {
  return apiFetch<ChatMessage>(messageApi(conversationId, messageId), {
    method: "PATCH",
    body: { content },
  });
}

export function deleteMessage(conversationId: string, messageId: string) {
  return apiFetch<void>(messageApi(conversationId, messageId), { method: "DELETE" });
}

/** Removes what followed and returns the user message to run again. */
export function retryMessage(conversationId: string, messageId: string) {
  return apiFetch<ChatMessage>(`${messageApi(conversationId, messageId)}/retry`, {
    method: "POST",
  });
}
