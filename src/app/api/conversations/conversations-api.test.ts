import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-level tests for the conversation API. Only the Auth.js cookie lookup is
 * replaced (it needs a real browser request); session → user resolution,
 * validation, ownership queries and error mapping all run for real.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth/config", () => ({ getAuthOptions: () => ({}) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");
}

const collection = await import("./route");
const item = await import("./[conversationId]/route");
const messages = await import("./[conversationId]/messages/route");
const replyRoute = await import("./[conversationId]/reply/route");
const messageItem = await import("./[conversationId]/messages/[messageId]/route");
const messageRetry = await import("./[conversationId]/messages/[messageId]/retry/route");
const mockedSession = vi.mocked(getServerSession);

function signInAs(userId: string | null) {
  mockedSession.mockResolvedValue(
    userId ? { user: { id: userId }, expires: new Date(Date.now() + 60_000).toISOString() } : null,
  );
}

function jsonRequest(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/conversations", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

describe("conversation API without a session", () => {
  beforeEach(() => {
    signInAs(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    ["POST /api/conversations", () => collection.POST(jsonRequest("POST", {}), ctx({}))],
    [
      "PATCH /api/conversations/:id",
      () => item.PATCH(jsonRequest("PATCH", { title: "x" }), ctx({ conversationId: "abc" })),
    ],
    [
      "DELETE /api/conversations/:id",
      () => item.DELETE(jsonRequest("DELETE"), ctx({ conversationId: "abc" })),
    ],
    [
      "POST /api/conversations/:id/messages",
      () => messages.POST(jsonRequest("POST", { content: "hi" }), ctx({ conversationId: "abc" })),
    ],
    [
      "POST /api/conversations/:id/reply",
      () => replyRoute.POST(jsonRequest("POST"), ctx({ conversationId: "abc" })),
    ],
    [
      "PATCH /api/conversations/:id (pin)",
      () => item.PATCH(jsonRequest("PATCH", { pinned: true }), ctx({ conversationId: "abc" })),
    ],
    [
      "PATCH /api/conversations/:id/messages/:messageId",
      () =>
        messageItem.PATCH(
          jsonRequest("PATCH", { content: "x" }),
          ctx({ conversationId: "abc", messageId: "m1" }),
        ),
    ],
    [
      "DELETE /api/conversations/:id/messages/:messageId",
      () =>
        messageItem.DELETE(jsonRequest("DELETE"), ctx({ conversationId: "abc", messageId: "m1" })),
    ],
    [
      "POST /api/conversations/:id/messages/:messageId/retry",
      () => messageRetry.POST(jsonRequest("POST"), ctx({ conversationId: "abc", messageId: "m1" })),
    ],
  ])("%s → 401", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("conversation API with sessions (PostgreSQL)", async () => {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  const EMAIL_DOMAIN = "@chat-api.integration.example.test";
  let alice: string;
  let bob: string;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { name: "Alice", email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { name: "Bob", email: `bob${EMAIL_DOMAIN}` } })).id;
  });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  async function createAs(userId: string, message: string) {
    signInAs(userId);
    const response = await collection.POST(jsonRequest("POST", { message }), ctx({}));
    expect(response.status).toBe(201);
    return (await response.json()).data.conversation.id as string;
  }

  it("creates the conversation for the session user, never a client-supplied one", async () => {
    signInAs(alice);
    const rejected = await collection.POST(
      jsonRequest("POST", { message: "x", userId: bob }),
      ctx({}),
    );
    expect(rejected.status).toBe(400);

    const id = await createAs(alice, "Format my resume");
    const row = await db.conversation.findUniqueOrThrow({ where: { id } });
    expect(row.userId).toBe(alice);
  });

  it("returns 404 (not 403) when another user targets a conversation", async () => {
    const bobsConversation = await createAs(bob, "Bob's resume");
    signInAs(alice);

    const rename = await item.PATCH(
      jsonRequest("PATCH", { title: "mine now" }),
      ctx({ conversationId: bobsConversation }),
    );
    const send = await messages.POST(
      jsonRequest("POST", { content: "injected" }),
      ctx({ conversationId: bobsConversation }),
    );
    const remove = await item.DELETE(
      jsonRequest("DELETE"),
      ctx({ conversationId: bobsConversation }),
    );

    for (const response of [rename, send, remove]) {
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toContain("Conversation not found.");
      expect(text).not.toContain(bob);
    }
    const row = await db.conversation.findUniqueOrThrow({
      where: { id: bobsConversation },
      include: { _count: { select: { messages: true } } },
    });
    expect(row.title).toBe("Bob's resume");
    expect(row._count.messages).toBe(1);
  });

  it("sends, renames and deletes the user's own conversation", async () => {
    const id = await createAs(alice, "First");

    const sent = await messages.POST(
      jsonRequest("POST", { content: "Second" }),
      ctx({ conversationId: id }),
    );
    expect(sent.status).toBe(201);
    expect((await sent.json()).data).toMatchObject({ role: "USER", content: "Second" });

    const renamed = await item.PATCH(
      jsonRequest("PATCH", { title: "Client A" }),
      ctx({ conversationId: id }),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).data.title).toBe("Client A");

    const deleted = await item.DELETE(jsonRequest("DELETE"), ctx({ conversationId: id }));
    expect(deleted.status).toBe(204);
    expect(await db.message.count({ where: { conversationId: id } })).toBe(0);
  });

  it("rejects empty and over-long messages with field issues", async () => {
    const id = await createAs(alice, "Hello");
    for (const content of ["   ", "x".repeat(20_001)]) {
      const response = await messages.POST(
        jsonRequest("POST", { content }),
        ctx({ conversationId: id }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.issues[0].path).toBe("content");
    }
  });
});
