import { describe, expect, it, vi } from "vitest";

import type { ResumeTaskInput } from "../../types";

import { createMimoProvider } from "./mimo-provider";

// Test-only fake key; no real MiMo calls are made (fetch is mocked).
const API_KEY = "sk-test-only-not-a-real-key";

const INPUT: ResumeTaskInput = {
  instruction: "Summarise my experience",
  history: [],
  resumes: [],
  availableTemplates: [],
};

const event = (data: unknown) =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const delta = (content: string, finish: string | null = null) =>
  event({ choices: [{ delta: { content }, finish_reason: finish }] });

/** An SSE response delivering `parts` as separate network chunks. */
function sse(parts: string[], { close = true } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        if (close) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createMimoProvider>[0]> = {},
) {
  return createMimoProvider({
    apiKey: API_KEY,
    timeoutMs: 5_000,
    maxOutputTokens: 1024,
    thinking: "disabled",
    fetch: fetchImpl,
    ...overrides,
  });
}

async function collect(iterable: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("MiMo streaming (mocked SSE)", () => {
  it("requests a stream and yields the reply text in order as it arrives", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        ": OPENROUTER PROCESSING\n\n",
        event({ choices: [{ delta: { role: "assistant", content: "" } }] }),
        delta("### Exp"),
        // One event split across two network chunks.
        'data: {"choices":[{"delta":{"content":"erience\\n- Six',
        ' years"}}]}\n\n',
        event({ choices: [{ delta: { reasoning_content: "secret thoughts" } }] }),
        delta(" in logistics", "stop"),
        event("[DONE]"),
      ]),
    );
    const chunks = await collect(provider(fetchMock).streamResumeTask(INPUT));

    expect(chunks.join("")).toBe("### Experience\n- Six years in logistics");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).not.toContain("secret thoughts");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init!.body));
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain("Markdown");
    expect(body.messages[0].content).not.toContain('"intent"');
    expect(new Headers(init!.headers).get("accept")).toBe("text/event-stream");
    expect(String(init!.body)).not.toContain(API_KEY);
  });

  it("uses OpenRouter's parameter names when streaming through OpenRouter", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sse([delta("Hi", "stop")]));
    await collect(
      provider(fetchMock, { baseUrl: "https://openrouter.ai/api/v1" }).streamResumeTask(INPUT),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
      model: "xiaomi/mimo-v2.6-pro",
      stream: true,
      max_tokens: 1024,
      reasoning: { enabled: false, exclude: true },
    });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [400, "bad_request"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i before the stream to %s", async (status, kind) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`{"error":"echo ${API_KEY}"}`, { status }));
    const error = await collect(provider(fetchMock).streamResumeTask(INPUT)).catch((e) => e);
    expect(error).toMatchObject({ kind, status });
    expect(String(error.message)).not.toContain(API_KEY);
  });

  it("turns an error event in the middle of the stream into a safe error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse([
          delta("Partial"),
          event({ error: { code: 502, message: "Provider returned error" } }),
        ]),
      );
    const seen: string[] = [];
    const error = await (async () => {
      for await (const chunk of provider(fetchMock).streamResumeTask(INPUT)) seen.push(chunk);
    })().catch((e) => e);
    expect(seen).toEqual(["Partial"]);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect(String(error.message)).not.toContain("Provider returned error");
  });

  it("treats a stream that ends before the model finished as interrupted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sse([delta("Half an ans")]));
    await expect(collect(provider(fetchMock).streamResumeTask(INPUT))).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("rejects content filtering, malformed events and empty replies", async () => {
    await expect(
      collect(
        provider(
          vi.fn<typeof fetch>().mockResolvedValue(sse([delta("", "content_filter")])),
        ).streamResumeTask(INPUT),
      ),
    ).rejects.toMatchObject({ kind: "content_filter" });
    await expect(
      collect(
        provider(
          vi.fn<typeof fetch>().mockResolvedValue(sse(["data: {not json\n\n"])),
        ).streamResumeTask(INPUT),
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(
      collect(
        provider(vi.fn<typeof fetch>().mockResolvedValue(sse([event("[DONE]")]))).streamResumeTask(
          INPUT,
        ),
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("accepts a reply cut at the output-token limit as finished", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse([delta("A long answer"), delta(" that stops", "length")], { close: false }),
      );
    expect((await collect(provider(fetchMock).streamResumeTask(INPUT))).join("")).toBe(
      "A long answer that stops",
    );
  });

  it("times out when the stream goes idle, and cancels the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      upstreamSignal = init!.signal!;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(delta("Started")));
            init!.signal!.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
      );
    });
    const seen: string[] = [];
    const error = await (async () => {
      for await (const chunk of provider(fetchMock, { timeoutMs: 40 }).streamResumeTask(INPUT)) {
        seen.push(chunk);
      }
    })().catch((e) => e);
    expect(seen).toEqual(["Started"]);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("Stop: the caller's signal cancels the request and rethrows the abort", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      upstreamSignal = init!.signal!;
      return sse([delta("First words")], { close: false });
    });
    const stop = new AbortController();
    const seen: string[] = [];
    const error = await (async () => {
      for await (const chunk of provider(fetchMock).streamResumeTask(INPUT, {
        signal: stop.signal,
      })) {
        seen.push(chunk);
        stop.abort(new DOMException("Stopped", "AbortError"));
      }
    })().catch((e) => e);
    expect(seen).toEqual(["First words"]);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("breaking out of the loop early cancels the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      upstreamSignal = init!.signal!;
      return sse([delta("One"), delta("Two")], { close: false });
    });
    for await (const _chunk of provider(fetchMock).streamResumeTask(INPUT)) break;
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
