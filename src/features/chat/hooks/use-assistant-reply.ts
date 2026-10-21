import { useCallback, useRef, useState } from "react";

import { ApiRequestError } from "@/lib/api/client";
import type { ChatMessage } from "@/lib/chat/types";
import type { FormattingJobView } from "@/lib/formatting/types";

import { streamReply } from "../lib/chat-api";
import { REPLY_FAILED_MESSAGE } from "../lib/copy";

/**
 * - thinking: the request is out and no text has arrived yet
 * - streaming: the reply is arriving (`text` so far)
 * - stopped: the user pressed Stop; the partial text was not saved
 * - failed: the reply broke off or could not start; nothing was saved
 * `id` changes with every request so the view can start each reply fresh.
 */
export type ReplyState =
  | { status: "idle"; id: number }
  | { status: "thinking"; id: number }
  | { status: "streaming"; id: number; text: string }
  | { status: "stopped"; id: number; text: string }
  | { status: "failed"; id: number; text: string; message: string };

export function isGenerating(state: ReplyState): boolean {
  return state.status === "thinking" || state.status === "streaming";
}

/**
 * Requests the assistant's reply and follows it as the server streams it.
 * Every state reflects the real request — nothing is simulated. The finished
 * reply is handed to `onReply` (it was saved on the server exactly once).
 */
export function useAssistantReply(
  conversationId: string,
  /** `null`: formatting started, and its progress card is the whole answer. */
  onReply: (message: ChatMessage | null) => void,
  onFormatting?: (job: FormattingJobView) => void,
) {
  const [state, setState] = useState<ReplyState>({ status: "idle", id: 0 });
  const controllerRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);

  const request = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++idRef.current;
    let text = "";
    // Ignore updates from a request that a newer one replaced.
    const update = (next: ReplyState) => {
      if (idRef.current === id) setState(next);
    };

    update({ status: "thinking", id });
    try {
      const message = await streamReply(conversationId, {
        signal: controller.signal,
        onFormatting: (job) => {
          if (idRef.current === id) onFormatting?.(job);
        },
        onDelta: (delta) => {
          text += delta;
          update({ status: "streaming", id, text });
        },
      });
      if (idRef.current !== id) return;
      onReply(message);
      setState({ status: "idle", id });
    } catch (error) {
      if (controller.signal.aborted) {
        update({ status: "stopped", id, text });
        return;
      }
      update({
        status: "failed",
        id,
        text,
        message: error instanceof ApiRequestError ? error.message : REPLY_FAILED_MESSAGE,
      });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [conversationId, onReply, onFormatting]);

  /** Stop generating: cancels the request; the server stops the model and saves nothing. */
  const stop = useCallback(() => controllerRef.current?.abort(), []);

  /** Forget a stopped/failed partial reply (e.g. the conversation changed under it). */
  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ status: "idle", id: ++idRef.current });
  }, []);

  return { state, request, stop, reset };
}
