"use client";

import { ArrowDown } from "lucide-react";
import { Fragment, type ReactNode, type RefObject } from "react";

import type { DisplayMessage } from "../lib/display-message";
import { MessageItem, type MessageActions } from "./message-item";

interface MessageListProps {
  messages: DisplayMessage[];
  hasOlderMessages: boolean;
  /** Scroll state from useStickToBottom (owned by the parent so it can follow sends). */
  containerRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  onScroll: () => void;
  onScrollToLatest: () => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  /** Rendered after the last message (e.g. a future streaming assistant reply). */
  footer?: ReactNode;
  /** Extra timeline items shown after a message (e.g. formatting job cards). */
  renderAfter?: (messageId: string) => ReactNode;
  /** Copy / edit / retry / delete on saved messages. */
  actions?: MessageActions;
}

export function MessageList({
  messages,
  hasOlderMessages,
  containerRef,
  isAtBottom,
  onScroll,
  onScrollToLatest,
  onRetry,
  onDiscard,
  footer,
  renderAfter,
  actions,
}: MessageListProps) {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
          {hasOlderMessages ? (
            <p className="mb-6 text-center text-xs text-muted-foreground">
              Showing the most recent messages.
            </p>
          ) : null}
          {/* role="log": new messages are announced politely by screen readers. */}
          <ol role="log" aria-label="Messages" className="space-y-6">
            {messages.map((message) => (
              <Fragment key={message.clientId ?? message.id}>
                <MessageItem
                  message={message}
                  onRetry={onRetry}
                  onDiscard={onDiscard}
                  actions={actions}
                />
                {renderAfter?.(message.id)}
              </Fragment>
            ))}
          </ol>
          {footer}
        </div>
      </div>

      {!isAtBottom ? (
        <button
          type="button"
          onClick={onScrollToLatest}
          aria-label="Scroll to latest message"
          className="absolute bottom-3 left-1/2 inline-flex size-11 -translate-x-1/2 items-center justify-center rounded-full border bg-background shadow-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
