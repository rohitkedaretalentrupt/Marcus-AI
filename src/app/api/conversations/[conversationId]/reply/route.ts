import { requireApiUser } from "@/lib/auth/session";
import { REPLY_STREAM_CONTENT_TYPE, type ReplyStreamEvent } from "@/lib/chat/reply-stream";
import {
  startAssistantReply,
  type AssistantReplyEvent,
} from "@/server/assistant/assistant-service";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { withErrorHandling } from "@/server/http/route-handler";

type Params = { conversationId: string };

function toWire(event: AssistantReplyEvent): ReplyStreamEvent {
  return event.type === "error"
    ? { type: "error", code: event.error.code, message: event.error.publicMessage }
    : event;
}

/**
 * Streams the assistant's reply to the newest user message of the caller's
 * own conversation (MiMo via the AIProvider abstraction) as NDJSON events —
 * see `ReplyStreamEvent`. The finished reply is saved once, at the end. When
 * the client disconnects (Stop generating), the model request is cancelled
 * and nothing is saved. The API key never leaves the server.
 */
export const POST = withErrorHandling<Params>(async (request, { params }) => {
  const user = await requireApiUser();
  enforceRateLimit(`assistant:${user.id}`, RATE_LIMITS.assistantReplyPerUser);

  const abort = new AbortController();
  const stop = () => abort.abort();
  request.signal.addEventListener("abort", stop, { once: true });

  const reply = await startAssistantReply(user.id, (await params).conversationId, abort.signal);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reply.events.next();
        if (next.done) {
          request.signal.removeEventListener("abort", stop);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(toWire(next.value))}\n`));
      } catch (error) {
        reply.release();
        controller.error(error);
      }
    },
    cancel() {
      stop(); // the client went away: cancel the model request; nothing is saved
      void reply.events.return(undefined);
      reply.release();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": REPLY_STREAM_CONTENT_TYPE,
      // no-transform: compression must not buffer the stream; X-Accel-Buffering: same for nginx.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
