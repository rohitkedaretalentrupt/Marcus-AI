"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { FormattingJobCard } from "@/features/formatting/components/formatting-job-card";
import { startChatFormatting } from "@/features/formatting/lib/formatting-api";
import { useRefreshWhile } from "@/hooks/use-refresh-while";
import { ApiRequestError } from "@/lib/api/client";
import type { ChatMessage, ConversationWithMessages } from "@/lib/chat/types";
import type { FileSummary } from "@/lib/files/types";
import { looksLikeFormatRequest } from "@/lib/formatting/chat-request";
import type { FormattingJobView } from "@/lib/formatting/types";

import { useStickToBottom } from "../hooks/use-stick-to-bottom";
import { isGenerating, useAssistantReply } from "../hooks/use-assistant-reply";
import { composerFootnote } from "../lib/copy";
import { deleteMessage, editMessage, retryMessage, sendMessage } from "../lib/chat-api";
import type { DisplayMessage } from "../lib/display-message";
import { conversationPath } from "@/lib/chat/routes";

import { AssistantReplyStatus } from "./assistant-reply-status";
import { ChatComposer } from "./chat-composer";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatHeader } from "./chat-header";
import type { MessageActions } from "./message-item";
import { MessageList } from "./message-list";

interface UnsentMessage {
  clientId: string;
  content: string;
  attachments: FileSummary[];
  createdAt: string;
  status: "sending" | "failed";
}

/**
 * An existing conversation. Sends are optimistic: the message appears at once
 * with a temporary client id, is replaced by the server's copy when persisted,
 * and on failure stays visible with "Try again" / "Discard" — it never
 * silently disappears.
 */
interface ConversationViewProps {
  conversation: ConversationWithMessages;
  /** An AI provider is configured on the server. */
  aiEnabled: boolean;
  /** Request a reply on arrival (new chat → first message just created). */
  autoReply: boolean;
  /** Formatting jobs started from this chat (oldest first). */
  formattingJobs: FormattingJobView[];
  /** Start formatting on arrival (new chat whose first message asked for it). */
  autoFormat: boolean;
}

const JOB_REFRESH_MS = 3000;

export function ConversationView({
  conversation,
  aiEnabled,
  autoReply,
  formattingJobs,
  autoFormat,
}: ConversationViewProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [unsent, setUnsent] = useState<UnsentMessage[]>([]);
  // Persisted by this tab but not yet included in the server props (until refresh lands).
  const [confirmed, setConfirmed] = useState<ChatMessage[]>([]);
  // Removed by edit / retry / delete; hidden at once instead of waiting for the refresh.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());

  const messages = useMemo<DisplayMessage[]>(() => {
    const serverIds = new Set(conversation.messages.map((message) => message.id));
    return [
      ...conversation.messages
        .filter((message) => !removedIds.has(message.id))
        .map((message) => ({ ...message, status: "sent" as const })),
      ...confirmed
        .filter((message) => !serverIds.has(message.id))
        .map((message) => ({ ...message, status: "sent" as const })),
      ...unsent.map((message) => ({
        id: message.clientId,
        clientId: message.clientId,
        role: "USER" as const,
        content: message.content,
        attachments: message.attachments,
        createdAt: message.createdAt,
        status: message.status,
      })),
    ];
  }, [conversation.messages, confirmed, unsent, removedIds]);

  // The finished reply (saved once on the server) replaces the streaming one in the same render.
  const onReply = useCallback(
    (reply: ChatMessage | null) => {
      if (reply) setConfirmed((current) => [...current, reply]);
      router.refresh();
    },
    [router],
  );
  // The server started formatting for this message: show its card now.
  const onFormatting = useCallback(() => router.refresh(), [router]);
  const reply = useAssistantReply(conversation.id, onReply, onFormatting);
  const generating = isGenerating(reply.state);
  // Follows new messages and the growing reply — only while the reader is near the bottom.
  const scroll = useStickToBottom(`${messages.length}:${reply.state.status}`);
  const { requestFollow } = scroll;

  // --- formatting from the chat -------------------------------------------------
  const [formatError, setFormatError] = useState<string | null>(null);
  useRefreshWhile(
    formattingJobs.some((job) => job.status === "QUEUED" || job.status === "PROCESSING"),
    JOB_REFRESH_MS,
  );

  async function startFormatting(body: {
    resumeFileId?: string;
    templateId?: string;
    text?: string;
  }) {
    await startChatFormatting(conversation.id, body);
    setFormatError(null);
    requestFollow();
    router.refresh();
  }

  const formatErrorFrom = (caught: unknown) =>
    caught instanceof ApiRequestError
      ? caught.displayMessage
      : "Formatting couldn't be started. Please try again.";

  /** Typed request ("Format my resume using Client A"): never throws; shows problems inline. */
  function formatFromMessage(text: string) {
    startFormatting({ text }).catch((caught: unknown) => setFormatError(formatErrorFrom(caught)));
  }

  // --- message actions: edit / retry / delete (ChatGPT-style) -----------------------
  const [actionBusy, setActionBusy] = useState(false);

  /**
   * Runs the user message again. With AI on, the reply request also starts
   * formatting when the message asks for it (the server decides, using the
   * conversation, and the reply says what happened); without AI, typed
   * format requests are started directly.
   */
  function rerun(userMessage: ChatMessage) {
    setFormatError(null);
    if (aiEnabled) void reply.request();
    else if (looksLikeFormatRequest(userMessage.content)) formatFromMessage(userMessage.content);
  }

  async function withAction(work: () => Promise<void>) {
    setActionBusy(true);
    try {
      await work();
    } finally {
      setActionBusy(false);
    }
  }

  /** Hides `messageId` (when `inclusive`) and everything after it until the refresh lands. */
  function hideFrom(messageId: string, inclusive: boolean) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    const gone = messages.slice(inclusive ? index : index + 1).map((message) => message.id);
    setRemovedIds((current) => new Set([...current, ...gone]));
  }

  const messageActions: MessageActions = {
    busy: actionBusy || generating,
    canRetry: (message) =>
      message.role === "ASSISTANT"
        ? aiEnabled
        : aiEnabled || looksLikeFormatRequest(message.content),
    onEdit: (messageId, content) =>
      withAction(async () => {
        const saved = await editMessage(conversation.id, messageId, content);
        hideFrom(messageId, false);
        setConfirmed([]); // later messages were removed on the server
        requestFollow();
        router.refresh();
        rerun(saved);
      }),
    onRetryTask: (messageId) =>
      withAction(async () => {
        const userMessage = await retryMessage(conversation.id, messageId);
        const retried = messages.find((message) => message.id === messageId);
        hideFrom(messageId, retried?.role === "ASSISTANT");
        setConfirmed([]);
        requestFollow();
        router.refresh();
        rerun(userMessage);
      }),
    onDelete: (messageId) =>
      withAction(async () => {
        await deleteMessage(conversation.id, messageId);
        setRemovedIds((current) => new Set([...current, messageId]));
        setConfirmed((current) => current.filter((message) => message.id !== messageId));
        reply.reset(); // a stopped/failed partial reply no longer belongs anywhere
        router.refresh();
      }),
  };

  // Each job card sits after the newest message that existed when it was started.
  const jobsAfter = useMemo(() => {
    const byMessage = new Map<string, FormattingJobView[]>();
    const sent = messages.filter((message) => message.status === "sent");
    for (const job of formattingJobs) {
      const anchor = sent.findLast((message) => message.createdAt <= job.createdAt) ?? sent.at(-1);
      if (!anchor) continue;
      byMessage.set(anchor.id, [...(byMessage.get(anchor.id) ?? []), job]);
    }
    return byMessage;
  }, [messages, formattingJobs]);
  const lastMessage = messages.at(-1);
  // A message whose formatting card is showing is answered by that card.
  const awaitingReply =
    aiEnabled &&
    lastMessage?.role === "USER" &&
    lastMessage.status === "sent" &&
    !jobsAfter.has(lastMessage.id);

  // New chat: the first message was created on the previous screen; ask for
  // the reply once, then drop the query flag so a reload does not repeat it.
  const autoRequested = useRef(false);
  useEffect(() => {
    if ((!autoReply && !autoFormat) || autoRequested.current) return;
    autoRequested.current = true;
    router.replace(conversationPath(conversation.id));
    if (autoReply && aiEnabled) void reply.request();
    const firstText = conversation.messages.findLast((message) => message.role === "USER")?.content;
    if (autoFormat && !aiEnabled && firstText) {
      startChatFormatting(conversation.id, { text: firstText }).then(
        () => router.refresh(),
        (caught: unknown) => setFormatError(formatErrorFrom(caught)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on arrival
  }, [autoReply, autoFormat]);

  async function deliver(clientId: string, content: string, attachments: FileSummary[]) {
    try {
      const saved = await sendMessage(
        conversation.id,
        content,
        attachments.map((file) => file.id),
      );
      setUnsent((current) => current.filter((message) => message.clientId !== clientId));
      setConfirmed((current) => [...current, saved]);
      router.refresh(); // re-sorts the sidebar by latest activity
      if (aiEnabled) void reply.request();
      else if (looksLikeFormatRequest(content)) formatFromMessage(content);
    } catch {
      setUnsent((current) =>
        current.map((message) =>
          message.clientId === clientId ? { ...message, status: "failed" } : message,
        ),
      );
    }
  }

  function handleSend(content: string, attachments: FileSummary[]): boolean {
    if (generating) return false; // wait for the reply (or stop it) first
    setFormatError(null);
    const clientId = `client-${crypto.randomUUID()}`;
    scroll.requestFollow();
    setUnsent((current) => [
      ...current,
      { clientId, content, attachments, createdAt: new Date().toISOString(), status: "sending" },
    ]);
    void deliver(clientId, content, attachments);
    return true;
  }

  function handleRetry(clientId: string) {
    const message = unsent.find((candidate) => candidate.clientId === clientId);
    if (!message) return;
    setUnsent((current) =>
      current.map((candidate) =>
        candidate.clientId === clientId ? { ...candidate, status: "sending" } : candidate,
      ),
    );
    void deliver(clientId, message.content, message.attachments);
  }

  function handleDiscard(clientId: string) {
    setUnsent((current) => current.filter((message) => message.clientId !== clientId));
  }

  return (
    <>
      <ChatHeader
        title={conversation.title}
        subtitle={
          conversation.clientTemplate ? `Template: ${conversation.clientTemplate.name}` : undefined
        }
      />
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ChatEmptyState
            onSuggestion={(prompt) => {
              setDraft(prompt);
              inputRef.current?.focus();
            }}
          />
        </div>
      ) : (
        <MessageList
          messages={messages}
          hasOlderMessages={conversation.hasOlderMessages}
          containerRef={scroll.containerRef}
          isAtBottom={scroll.isAtBottom}
          onScroll={scroll.onScroll}
          onScrollToLatest={() => scroll.scrollToBottom("smooth")}
          onRetry={handleRetry}
          onDiscard={handleDiscard}
          actions={messageActions}
          renderAfter={(messageId) =>
            jobsAfter.get(messageId)?.map((job) => (
              <li key={job.id} aria-label="Formatting">
                <FormattingJobCard job={job} />
              </li>
            ))
          }
          footer={
            aiEnabled ? (
              <AssistantReplyStatus
                state={reply.state}
                onGrow={scroll.keepFollowing}
                awaitingReply={awaitingReply}
                onRequest={() => {
                  requestFollow();
                  void reply.request();
                }}
              />
            ) : null
          }
        />
      )}
      <div className="shrink-0">
        {formatError ? (
          <div className="mx-auto w-full max-w-3xl px-3 pt-2 md:px-6">
            <FormAlert message={formatError} />
          </div>
        ) : null}
        <ChatComposer
          value={draft}
          onValueChange={setDraft}
          onSend={handleSend}
          inputRef={inputRef}
          footnote={composerFootnote(aiEnabled)}
          generating={generating}
          onStop={reply.stop}
        />
      </div>
    </>
  );
}
