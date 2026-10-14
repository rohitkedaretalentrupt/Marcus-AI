import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "@/lib/api/client";
import { splitReplyEvents, type ReplyStreamEvent } from "@/lib/chat/reply-stream";
import type { ChatMessage } from "@/lib/chat/types";

import { REPLY_INTERRUPTED_MESSAGE, streamReply } from "./chat-api";

const SAVED: ChatMessage = {
  id: "m1",
  role: "ASSISTANT",
  content: "Hello there",
  attachments: [],
  createdAt: "2026-10-08T00:00:00.000Z",
};

const line = (event: ReplyStreamEvent) => `${JSON.stringify(event)}\n`;

/** A streamed NDJSON response delivering `parts` as separate network chunks. */
function ndjson(parts: string[], { close = true } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        if (close) controller.close();
      },
    }),
    { status: 200 },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("splitReplyEvents", () => {
  it("returns complete lines and keeps the unfinished tail", () => {
    const text = line({ type: "delta", text: "a" }) + '{"type":"delta","te';
    expect(splitReplyEvents(text)).toEqual({
      events: [{ type: "delta", text: "a" }],
      rest: '{"type":"delta","te',
    });
  });
});

describe("streamReply (browser side, mocked fetch)", () => {
  it("passes each piece of text on as it arrives and resolves with the saved message", async () => {
    const both = line({ type: "delta", text: "Hello" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          ndjson([
            both.slice(0, 10),
            both.slice(10),
            line({ type: "delta", text: " there" }),
            line({ type: "done", message: SAVED }),
          ]),
        ),
    );
    const deltas: string[] = [];
    const message = await streamReply("c1", {
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(["Hello", " there"]);
    expect(message).toEqual(SAVED);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/conversations/c1/reply");
  });

  it("rejects with the server's safe message when the reply fails mid-stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjson([
          line({ type: "delta", text: "Part" }),
          line({
            type: "error",
            code: "SERVICE_UNAVAILABLE",
            message: "The assistant took too long to respond. Please try again.",
          }),
        ]),
      ),
    );
    const error = await streamReply("c1", {
      signal: new AbortController().signal,
      onDelta: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "The assistant took too long to respond. Please try again.",
    });
  });

  it("treats a connection that closes before 'done' as interrupted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjson([line({ type: "delta", text: "Par" })])),
    );
    await expect(
      streamReply("c1", { signal: new AbortController().signal, onDelta: () => {} }),
    ).rejects.toMatchObject({ message: REPLY_INTERRUPTED_MESSAGE });
  });

  it("reports errors that happen before streaming as normal API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: "CONFLICT", message: "A reply is already being generated." } },
            { status: 409 },
          ),
        ),
    );
    await expect(
      streamReply("c1", { signal: new AbortController().signal, onDelta: () => {} }),
    ).rejects.toMatchObject({ status: 409, message: "A reply is already being generated." });
  });

  it("Stop: aborting rejects with the abort error (not a failure message)", async () => {
    const stop = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(line({ type: "delta", text: "Partial" })));
              init.signal!.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
        );
      }),
    );
    const deltas: string[] = [];
    const error = await streamReply("c1", {
      signal: stop.signal,
      onDelta: (text) => {
        deltas.push(text);
        stop.abort();
      },
    }).catch((e: unknown) => e);
    expect(deltas).toEqual(["Partial"]);
    expect(error).not.toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
