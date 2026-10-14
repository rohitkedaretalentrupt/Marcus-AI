"use client";

import { AlertCircle, FileText, RotateCw } from "lucide-react";
import { useLayoutEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

import type { ReplyState } from "../hooks/use-assistant-reply";
import { useSmoothText } from "../hooks/use-smooth-text";
import { MarkdownContent } from "./markdown-content";

interface AssistantReplyStatusProps {
  state: ReplyState;
  /** Called whenever the streaming text grows (to keep it in view). */
  onGrow: () => void;
  /** The newest message is the user's and has no reply (e.g. after a failure, stop or reload). */
  awaitingReply: boolean;
  onRequest: () => void;
}

/** Same layout as a saved assistant message, so the finished reply replaces it seamlessly. */
function AssistantShell({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <div className="mt-6 flex gap-3" aria-busy={busy || undefined}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground",
          busy && "animate-pulse border-primary/60 text-primary",
        )}
      >
        <FileText className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Only this re-renders as text arrives — not the rest of the conversation. */
function StreamingText({
  text,
  resetKey,
  onGrow,
}: {
  text: string;
  resetKey: number;
  onGrow: () => void;
}) {
  const shown = useSmoothText(text, true, resetKey);
  useLayoutEffect(onGrow, [shown.length, onGrow]);
  return <MarkdownContent text={shown} streaming />;
}

/**
 * The reply in progress: "Thinking…" until the first text arrives, then the
 * text as it streams, or what happened when it did not finish. Nothing here
 * is simulated — every state follows the real request.
 */
export function AssistantReplyStatus({
  state,
  onGrow,
  awaitingReply,
  onRequest,
}: AssistantReplyStatusProps) {
  if (state.status === "thinking") {
    return (
      <AssistantShell busy>
        <p role="status" className="thinking-shimmer pt-0.5 leading-7 font-medium">
          Thinking…
        </p>
      </AssistantShell>
    );
  }

  if (state.status === "streaming") {
    return (
      <AssistantShell busy>
        <span className="sr-only" role="status">
          The assistant is replying…
        </span>
        <StreamingText text={state.text} resetKey={state.id} onGrow={onGrow} />
      </AssistantShell>
    );
  }

  if ((state.status === "stopped" || state.status === "failed") && awaitingReply) {
    const failed = state.status === "failed";
    return (
      <AssistantShell>
        {state.text.trim() ? (
          <MarkdownContent text={state.text} className="text-muted-foreground" />
        ) : null}
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "flex flex-wrap items-center gap-2 text-sm",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failed ? <AlertCircle className="size-4" aria-hidden="true" /> : null}
          {failed ? state.message : "You stopped this reply, so it wasn't saved."}
          <Button variant="outline" size="sm" onClick={onRequest}>
            <RotateCw aria-hidden="true" />
            {failed ? "Try again" : "Retry"}
          </Button>
        </div>
      </AssistantShell>
    );
  }

  if (awaitingReply) {
    return (
      <div className="mt-6">
        <Button variant="outline" size="sm" onClick={onRequest}>
          Get a reply
        </Button>
      </div>
    );
  }
  return null;
}
