import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AIProvider } from "@/lib/ai/types";
import type { ReplyStreamEvent } from "@/lib/chat/reply-stream";
import { createFakeAIProvider } from "@test/fakes/fake-ai-provider";

/**
 * HTTP-level tests for the streamed reply: real route, real PostgreSQL, a
 * MOCKED AI provider (no MiMo calls) and a mocked Auth.js cookie lookup.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth/config", () => ({ getAuthOptions: () => ({}) }));

let provider: AIProvider | null = null;
vi.mock("@/lib/ai/provider", async () => {
  const { ServiceUnavailableError } = await import("@/lib/errors/app-error");
  return {
    isAIEnabled: () => provider !== null,
    getAIProvider: () => {
      if (!provider) throw new ServiceUnavailableError("AI responses aren't available right now.");
      return provider;
    },
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");
}

const API_KEY = "sk-test-only-not-a-real-key";

describe.skipIf(!TEST_DATABASE_URL)("POST /api/conversations/:id/reply (streaming)", async () => {
  const { getDb } = await import("@/lib/db/client");
  const chat = await import("@/server/chat/conversation-service");
  const { AIProviderError } = await import("@/lib/ai/errors");
  const route = await import("./route");
  const db = getDb();
  const EMAIL_DOMAIN = "@reply-stream.integration.example.test";
  let alice: string;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(() => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: alice },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  const post = (conversationId: string, signal?: AbortSignal) =>
    route.POST(
      new NextRequest(`http://localhost/api/conversations/${conversationId}/reply`, {
        method: "POST",
        signal,
      }),
      { params: Promise.resolve({ conversationId }) },
    );

  async function readEvents(response: Response): Promise<ReplyStreamEvent[]> {
    const text = await response.text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReplyStreamEvent);
  }

  const assistantCount = (conversationId: string) =>
    db.message.count({ where: { conversationId, role: "ASSISTANT" } });

  it("streams NDJSON deltas, then the saved message; one ASSISTANT row is stored", async () => {
    provider = createFakeAIProvider({
      streamResumeTask: async function* () {
        yield "**Hello**";
        yield " there";
      },
    });
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    const response = await post(conversation.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    const events = await readEvents(response);
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", text: "**Hello**" },
      { type: "delta", text: " there" },
    ]);
    expect(events[2]).toMatchObject({
      type: "done",
      message: { role: "ASSISTANT", content: "**Hello** there" },
    });
    expect(events).toHaveLength(3);
    expect(await assistantCount(conversation.id)).toBe(1);
  });

  it("a failure mid-stream ends with a safe error event and stores nothing", async () => {
    provider = createFakeAIProvider({
      streamResumeTask: async function* () {
        yield "Partial";
        throw new AIProviderError("auth", `MiMo rejected ${API_KEY}`, 401);
      },
    });
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    const response = await post(conversation.id);
    const raw = await response.clone().text();
    const events = await readEvents(response);

    expect(events.at(-1)).toEqual({
      type: "error",
      code: "SERVICE_UNAVAILABLE",
      message: "The assistant is unavailable right now.",
    });
    expect(raw).not.toContain(API_KEY);
    expect(await assistantCount(conversation.id)).toBe(0);
  });

  it("Stop: when the client goes away the model request is cancelled and nothing is saved", async () => {
    let providerSignal: AbortSignal | undefined;
    provider = createFakeAIProvider({
      streamResumeTask: async function* (_input, options) {
        providerSignal = options?.signal;
        yield "First words";
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        throw options?.signal?.reason;
      },
    });
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    const response = await post(conversation.id);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first)).toEqual({ type: "delta", text: "First words" });

    await reader.cancel(); // what the browser does when Stop aborts the fetch
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    expect(await assistantCount(conversation.id)).toBe(0);

    // The conversation is free again: Retry streams a fresh reply.
    provider = createFakeAIProvider({
      streamResumeTask: async function* () {
        yield "Fresh answer";
      },
    });
    const retry = await post(conversation.id);
    expect(retry.status).toBe(200);
    expect((await readEvents(retry)).at(-1)).toMatchObject({ type: "done" });
    expect(await assistantCount(conversation.id)).toBe(1);
  });

  it("errors before streaming are ordinary JSON responses (AI not configured, already answered)", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    provider = null;
    const unavailable = await post(conversation.id);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.message).toBe(
      "AI responses aren't available right now.",
    );

    provider = createFakeAIProvider({
      streamResumeTask: async function* () {
        yield "Answer";
      },
    });
    await (await post(conversation.id)).text();
    const again = await post(conversation.id);
    expect(again.status).toBe(409);
    expect(await assistantCount(conversation.id)).toBe(1);
  });
});
