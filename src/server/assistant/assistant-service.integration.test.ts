import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AIProvider, ResumeTaskInput } from "@/lib/ai/types";
import type { FormattingJobView } from "@/lib/formatting/types";
import { createFakeAIProvider } from "@test/fakes/fake-ai-provider";

/**
 * Assistant orchestration against a REAL PostgreSQL database with a MOCKED AI
 * provider (no MiMo calls).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@assistant.integration.example.test";

describe.skipIf(!TEST_DATABASE_URL)("assistant replies (PostgreSQL, mocked AI)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { AIProviderError } = await import("@/lib/ai/errors");
  const { NotFoundError } = await import("@/lib/errors/app-error");
  const chat = await import("@/server/chat/conversation-service");
  const assistant = await import("./assistant-service");

  const db = getDb();
  let alice: string;
  let bob: string;
  let counter = 0;
  let calls: ResumeTaskInput[];

  /** Streams the fake reply in two chunks, like a model would. */
  function fakeProvider(impl: (input: ResumeTaskInput) => Promise<{ reply: string }>): AIProvider {
    return createFakeAIProvider({
      streamResumeTask: async function* (input) {
        calls.push(input);
        const { reply } = await impl(input);
        const middle = Math.ceil(reply.length / 2);
        yield reply.slice(0, middle);
        yield reply.slice(middle);
      },
    });
  }

  /** A provider whose stream the test drives: write text, then end or fail. */
  function controlledProvider() {
    const queue: Array<{ text?: string; end?: true; error?: Error }> = [];
    let wake: (() => void) | null = null;
    const state: { signal?: AbortSignal } = {};
    const push = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
    };
    const provider = createFakeAIProvider({
      streamResumeTask: async function* (input, options) {
        calls.push(input);
        state.signal = options?.signal;
        for (;;) {
          while (queue.length === 0) {
            if (options?.signal?.aborted) throw options.signal.reason;
            await new Promise<void>((resolve) => {
              wake = resolve;
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          const item = queue.shift()!;
          if (item.error) throw item.error;
          if (item.end) return;
          yield item.text!;
        }
      },
    });
    return {
      provider,
      state,
      write: (text: string) => push({ text }),
      end: () => push({ end: true }),
      fail: (error: Error) => push({ error }),
    };
  }

  const assistantCount = (conversationId: string) =>
    db.message.count({ where: { conversationId, role: "ASSISTANT" } });
  const deps = (provider: AIProvider) => ({ getProvider: () => provider, extractionWaitMs: 0 });
  const ok = fakeProvider(async () => ({ reply: "Here is my answer." }));

  async function resumeFile(userId: string, status: "READY" | "FAILED" = "READY") {
    const id = `a${Date.now().toString(16)}${(counter++).toString(16).padStart(6, "0")}`;
    await db.uploadedFile.create({
      data: {
        id,
        userId,
        originalFilename: "cv.pdf",
        storageKey: `users/${userId}/uploads/${id}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 100,
        status: status === "READY" ? "READY" : "UPLOADED",
        extraction: {
          create: {
            userId,
            status,
            parserVersion: 1,
            rawText: "SECRET RAW TEXT",
            failureCode: status === "FAILED" ? "no_text" : null,
            content:
              status === "READY"
                ? { contact: { fullName: "Sam Rivera", links: [] }, sections: [] }
                : undefined,
          },
        },
      },
    });
    return id;
  }

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(() => {
    calls = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("stores the AI reply as an ASSISTANT message in the same conversation", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "Hi there" });
    const reply = await assistant.generateAssistantReply(alice, conversation.id, deps(ok));

    expect(reply).toMatchObject({
      role: "ASSISTANT",
      content: "Here is my answer.",
      attachments: [],
    });
    const reloaded = await chat.getConversation(alice, conversation.id);
    expect(reloaded?.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(calls[0]!.instruction).toBe("Hi there");
  });

  it("provides the structured ResumeContent (not raw text or storage keys) as context", async () => {
    const fileId = await resumeFile(alice);
    const { conversation } = await chat.createConversation(alice, {
      message: "Review my resume",
      attachmentFileIds: [fileId],
    });
    await assistant.generateAssistantReply(alice, conversation.id, deps(ok));

    const input = calls[0]!;
    expect(input.resumes).toEqual([
      {
        filename: "cv.pdf",
        content: { contact: { fullName: "Sam Rivera", links: [] }, sections: [] },
      },
    ]);
    expect(input.instruction).toContain("(Attached: cv.pdf)");
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("SECRET RAW TEXT");
    expect(serialized).not.toContain("users/");
    expect(serialized).not.toContain(fileId);
  });

  it("explains unreadable resumes to the model", async () => {
    const fileId = await resumeFile(alice, "FAILED");
    const { conversation } = await chat.createConversation(alice, {
      message: "",
      attachmentFileIds: [fileId],
    });
    await assistant.generateAssistantReply(alice, conversation.id, deps(ok));
    expect(calls[0]!.resumes[0]).toMatchObject({
      content: null,
      note: expect.stringMatching(/scanned/),
    });
    expect(calls[0]!.instruction).toContain("(Attached: cv.pdf)");
  });

  it("passes earlier turns as history (oldest first)", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "First" });
    await assistant.generateAssistantReply(alice, conversation.id, deps(ok));
    await chat.sendUserMessage(alice, conversation.id, { content: "Second" });
    await assistant.generateAssistantReply(alice, conversation.id, deps(ok));

    expect(calls[1]!.history).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Here is my answer." },
    ]);
    expect(calls[1]!.instruction).toBe("Second");
  });

  it("refuses to answer twice or answer someone else's conversation", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    await expect(
      assistant.generateAssistantReply(bob, conversation.id, deps(ok)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await assistant.generateAssistantReply(alice, conversation.id, deps(ok));
    await expect(
      assistant.generateAssistantReply(alice, conversation.id, deps(ok)),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each([
    ["timeout", 504],
    ["rate_limited", 429],
    ["invalid_response", 502],
    ["auth", 503],
  ] as const)("maps a provider %s to a safe %i and stores nothing", async (kind, status) => {
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    const failing = fakeProvider(async () => {
      throw new AIProviderError(kind, `provider ${kind}`);
    });
    const error = await assistant
      .generateAssistantReply(alice, conversation.id, deps(failing))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status });
    expect(String((error as { publicMessage: string }).publicMessage)).not.toContain("provider");
    expect(
      await db.message.count({ where: { conversationId: conversation.id, role: "ASSISTANT" } }),
    ).toBe(0);

    // A retry after the failure works.
    await expect(
      assistant.generateAssistantReply(alice, conversation.id, deps(ok)),
    ).resolves.toMatchObject({
      role: "ASSISTANT",
    });
  });

  it("never logs prompts, resume content or replies", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fileId = await resumeFile(alice);
    const { conversation } = await chat.createConversation(alice, {
      message: "Private question about my salary",
      attachmentFileIds: [fileId],
    });
    const failing = fakeProvider(async () => {
      throw new AIProviderError("timeout", "timed out");
    });
    await assistant.generateAssistantReply(alice, conversation.id, deps(failing)).catch(() => {});

    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("AI reply failed");
    expect(logged).not.toContain("salary");
    expect(logged).not.toContain("Sam Rivera");
  });

  it("returns 503 when no AI provider is configured", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });
    const { ServiceUnavailableError } = await import("@/lib/errors/app-error");
    const notConfigured = {
      getProvider: () => {
        throw new ServiceUnavailableError("AI responses aren't available right now.");
      },
      extractionWaitMs: 0,
    };
    await expect(
      assistant.generateAssistantReply(alice, conversation.id, notConfigured),
    ).rejects.toMatchObject({ status: 503 });
  });
  describe("streaming", () => {
    it("streams the reply in pieces, then saves it once as a single message", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );

      live.write("### Summary\n");
      expect(await reply.events.next()).toEqual({
        done: false,
        value: { type: "delta", text: "### Summary\n" },
      });
      // Nothing is stored while the reply is still being written.
      expect(await assistantCount(conversation.id)).toBe(0);

      live.write("- Strong **SQL** skills");
      expect((await reply.events.next()).value).toEqual({
        type: "delta",
        text: "- Strong **SQL** skills",
      });
      live.end();
      expect((await reply.events.next()).value).toMatchObject({
        type: "done",
        message: { role: "ASSISTANT", content: "### Summary\n- Strong **SQL** skills" },
      });
      expect((await reply.events.next()).done).toBe(true);
      expect(await assistantCount(conversation.id)).toBe(1);
    });

    it("Stop: aborting cancels the model request, saves nothing and frees the conversation", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const stop = new AbortController();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        stop.signal,
        deps(live.provider),
      );
      live.write("Partial ans");
      await reply.events.next();

      const pending = reply.events.next();
      stop.abort();
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(live.state.signal?.aborted).toBe(true);
      expect(await assistantCount(conversation.id)).toBe(0);

      // Retry right away: a fresh reply can start and is saved once.
      await expect(
        assistant.generateAssistantReply(alice, conversation.id, deps(ok)),
      ).resolves.toMatchObject({ content: "Here is my answer." });
      expect(await assistantCount(conversation.id)).toBe(1);
    });

    it("an AI error mid-stream reports a safe message and saves nothing", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );
      live.write("Half of an answer");
      await reply.events.next();
      live.fail(new AIProviderError("unavailable", "stream ended before the reply finished"));

      const event = (await reply.events.next()).value as {
        type: string;
        error: { status: number; publicMessage: string };
      };
      expect(event).toMatchObject({ type: "error", error: { status: 503 } });
      expect(event.error.publicMessage).not.toContain("stream ended");
      expect((await reply.events.next()).done).toBe(true);
      expect(await assistantCount(conversation.id)).toBe(0);
    });

    it("a timeout mid-stream maps to 504 and saves nothing", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );
      live.write("Slow");
      await reply.events.next();
      live.fail(new AIProviderError("timeout", "idle"));
      expect((await reply.events.next()).value).toMatchObject({
        type: "error",
        error: { status: 504 },
      });
      expect(await assistantCount(conversation.id)).toBe(0);
    });

    it("an unexpected error mid-stream is reported generically", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );
      live.fail(new Error("socket hang up"));
      expect((await reply.events.next()).value).toMatchObject({
        type: "error",
        error: { status: 500 },
      });
      expect(await assistantCount(conversation.id)).toBe(0);
    });

    it("a second reply is refused while one is streaming; the message is answered once", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );
      await expect(
        assistant.startAssistantReply(
          alice,
          conversation.id,
          new AbortController().signal,
          deps(ok),
        ),
      ).rejects.toMatchObject({ status: 409 });

      live.write("Only answer");
      live.end();
      const events = [];
      for await (const event of reply.events) events.push(event.type);
      expect(events).toEqual(["delta", "done"]);
      expect(await assistantCount(conversation.id)).toBe(1);
      await expect(
        assistant.generateAssistantReply(alice, conversation.id, deps(ok)),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("does not save the reply if the conversation moved on while it streamed", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "First" });
      const live = controlledProvider();
      const reply = await assistant.startAssistantReply(
        alice,
        conversation.id,
        new AbortController().signal,
        deps(live.provider),
      );
      live.write("Answer to first");
      await reply.events.next();
      await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "USER",
          content: "Second",
          createdAt: new Date(Date.now() + 1000),
        },
      });
      live.end();
      expect((await reply.events.next()).value).toMatchObject({
        type: "error",
        error: { status: 409 },
      });
      expect(await assistantCount(conversation.id)).toBe(0);
    });

    it("Regenerate replaces the reply: never two answers to one message", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const first = await assistant.generateAssistantReply(alice, conversation.id, deps(ok));
      await chat.prepareRetry(alice, conversation.id, first!.id);
      const again = fakeProvider(async () => ({ reply: "A better answer." }));
      await assistant.generateAssistantReply(alice, conversation.id, deps(again));

      const rows = await db.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((row) => [row.role, row.content])).toEqual([
        ["USER", "Hi"],
        ["ASSISTANT", "A better answer."],
      ]);
    });

    it("an empty streamed reply is an error, not an empty message", async () => {
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      const blank = fakeProvider(async () => ({ reply: "  \n " }));
      await expect(
        assistant.generateAssistantReply(alice, conversation.id, deps(blank)),
      ).rejects.toMatchObject({ status: 502 });
      expect(await assistantCount(conversation.id)).toBe(0);
    });
  });
  describe("formatting requested in the chat", () => {
    const job = {
      id: "job1",
      status: "QUEUED",
      template: { id: "t1", name: "Zillow" },
      resume: { fileId: "f1", filename: "cv.pdf" },
    } as unknown as FormattingJobView;

    function withFormatting(
      outcome: { status: "started"; job: typeof job } | { status: "not_started"; reason: string },
    ) {
      const startFormatting = vi.fn(async () => outcome);
      return {
        startFormatting,
        deps: { getProvider: () => ok, extractionWaitMs: 0, startFormatting },
      };
    }

    async function eventsOf(
      conversationId: string,
      deps: Parameters<typeof assistant.startAssistantReply>[3],
    ) {
      const reply = await assistant.startAssistantReply(
        alice,
        conversationId,
        new AbortController().signal,
        deps,
      );
      const events = [];
      for await (const event of reply.events) events.push(event);
      return events;
    }

    it("starts the job and announces it: no model call, no reply text", async () => {
      const { conversation } = await chat.createConversation(alice, {
        message: "Format my resume using Zillow",
      });
      const { startFormatting, deps: d } = withFormatting({ status: "started", job });
      const events = await eventsOf(conversation.id, d);

      expect(startFormatting).toHaveBeenCalledWith(
        alice,
        conversation.id,
        "Format my resume using Zillow",
        null,
      );
      // The progress card is the whole answer: nothing is written or saved.
      expect(events).toMatchObject([{ type: "formatting" }, { type: "done", message: null }]);
      expect(calls).toHaveLength(0);
      expect(await assistantCount(conversation.id)).toBe(0);
    });

    it("a 'yes' to a reply that offered formatting counts, with that reply as context", async () => {
      const { conversation } = await chat.createConversation(alice, {
        message: "format as per abbott",
      });
      const offer = "There is no Abbott template. Want me to go ahead with Zillow instead?";
      await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: offer,
          createdAt: new Date(Date.now() + 1000),
        },
      });
      await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "USER",
          content: "yes",
          createdAt: new Date(Date.now() + 2000),
        },
      });
      const { startFormatting, deps: d } = withFormatting({ status: "started", job });
      await eventsOf(conversation.id, d);
      expect(startFormatting).toHaveBeenCalledWith(alice, conversation.id, "yes", offer);
    });

    it("when formatting cannot start, the model gets the reason and no card is announced", async () => {
      const { conversation } = await chat.createConversation(alice, {
        message: "Format my resume using Zillow",
      });
      const reason = "Attach a PDF or DOCX resume in this chat first, then ask me to format it.";
      const { deps: d } = withFormatting({ status: "not_started", reason });
      const events = await eventsOf(conversation.id, d);
      expect(events.map((event) => event.type)).not.toContain("formatting");
      expect(calls[0]!.formatting).toEqual({ status: "not_started", reason });
    });

    it("ordinary messages never start formatting", async () => {
      const { conversation } = await chat.createConversation(alice, {
        message: "what's your name?",
      });
      const { startFormatting, deps: d } = withFormatting({ status: "started", job });
      await eventsOf(conversation.id, d);
      expect(startFormatting).not.toHaveBeenCalled();
      expect(calls[0]!.formatting).toBeUndefined();
    });
  });
});
