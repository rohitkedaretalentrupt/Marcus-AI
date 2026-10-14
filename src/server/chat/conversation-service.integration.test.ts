import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ownership and persistence rules, verified against a REAL PostgreSQL database
 * (TEST_DATABASE_URL; prepare with `npm run db:test:prepare`). Fixture users
 * are created directly and have no credentials.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@chat-service.integration.example.test";

describe.skipIf(!TEST_DATABASE_URL)("conversation service (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { NotFoundError, ValidationError } = await import("@/lib/errors/app-error");
  const service = await import("./conversation-service");

  const db = getDb();
  let alice: string;
  let bob: string;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { name: "Alice", email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { name: "Bob", email: `bob${EMAIL_DOMAIN}` } })).id;
  });

  beforeEach(async () => {
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } });
  });

  afterAll(async () => {
    await cleanup(); // cascades to conversations and messages
    await db.$disconnect();
  });

  describe("create + list", () => {
    it("creates an empty conversation with the default title", async () => {
      const { conversation, message } = await service.createConversation(alice, {});
      expect(conversation.title).toBe("New conversation");
      expect(message).toBeNull();
    });

    it("creates a conversation with its first user message atomically", async () => {
      const { conversation, message } = await service.createConversation(alice, {
        message: "Format my resume\nusing Client A",
      });

      expect(conversation.title).toBe("Format my resume");
      expect(message).toMatchObject({ role: "USER", content: "Format my resume\nusing Client A" });
      expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1);
    });

    it("lists only the user's own conversations, most recently active first", async () => {
      const older = await service.createConversation(alice, { message: "older" });
      await service.createConversation(bob, { message: "bob's" });
      const newer = await service.createConversation(alice, { message: "newer" });
      await service.sendUserMessage(alice, older.conversation.id, { content: "bump" });

      const page = await service.listConversations(alice);
      expect(page.items.map((c) => c.id)).toEqual([older.conversation.id, newer.conversation.id]);
      expect(page.nextCursor).toBeNull();
      expect(page.items[0]).not.toHaveProperty("userId");
    });

    it("paginates with a cursor", async () => {
      for (const n of [1, 2, 3]) await service.createConversation(alice, { message: `m${n}` });

      const first = await service.listConversations(alice, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBe(first.items[1]!.id);

      const second = await service.listConversations(alice, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe("ownership", () => {
    it("does not return another user's conversation (or reveal that it exists)", async () => {
      const { conversation } = await service.createConversation(bob, { message: "private" });

      await expect(service.getConversation(alice, conversation.id)).resolves.toBeNull();
      await expect(service.getConversation(alice, "does-not-exist")).resolves.toBeNull();
      await expect(service.getConversation(alice, "../../etc")).resolves.toBeNull();
      await expect(service.getConversation(bob, conversation.id)).resolves.toMatchObject({
        id: conversation.id,
      });
    });

    it("cannot rename another user's conversation", async () => {
      const { conversation } = await service.createConversation(bob, { message: "bob" });

      await expect(
        service.renameConversation(alice, conversation.id, { title: "hijacked" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).title,
      ).toBe("bob");
    });

    it("cannot delete another user's conversation", async () => {
      const { conversation } = await service.createConversation(bob, { message: "bob" });

      await expect(service.deleteConversation(alice, conversation.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await db.conversation.count({ where: { id: conversation.id } })).toBe(1);
    });

    it("cannot add messages to another user's conversation", async () => {
      const { conversation } = await service.createConversation(bob, { message: "bob" });

      await expect(
        service.sendUserMessage(alice, conversation.id, { content: "injected" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1);
    });

    it("reads messages only through an owned conversation", async () => {
      const { conversation } = await service.createConversation(bob, { message: "secret" });
      await service.sendUserMessage(bob, conversation.id, { content: "more secret" });

      const asBob = await service.getConversation(bob, conversation.id);
      expect(asBob?.messages.map((m) => m.content)).toEqual(["secret", "more secret"]);
      expect(await service.getConversation(alice, conversation.id)).toBeNull();
    });
  });

  describe("messages", () => {
    it("stores a user message, preserves whitespace and bumps lastMessageAt", async () => {
      const { conversation } = await service.createConversation(alice, {});
      const longAgo = new Date("2020-01-01T00:00:00Z");
      await db.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: longAgo },
      });
      const content = "Line one\n\n  - indented bullet";

      const message = await service.sendUserMessage(alice, conversation.id, { content });
      expect(message).toMatchObject({ role: "USER", content });

      const reloaded = await service.getConversation(alice, conversation.id);
      expect(reloaded?.messages.map((m) => m.id)).toEqual([message.id]);
      expect(new Date(reloaded!.lastMessageAt).getTime()).toBeGreaterThan(longAgo.getTime());
    });

    it("rejects empty and over-long messages without writing anything", async () => {
      const { conversation } = await service.createConversation(alice, {});

      for (const content of ["", "   \n ", "x".repeat(20_001)]) {
        await expect(
          service.sendUserMessage(alice, conversation.id, { content }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    it("rejects a client attempt to set the role", async () => {
      const { conversation } = await service.createConversation(alice, {});
      await expect(
        service.sendUserMessage(alice, conversation.id, { content: "hi", role: "ASSISTANT" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("rename + delete", () => {
    it("renames with a trimmed title and validates it", async () => {
      const { conversation } = await service.createConversation(alice, {});

      const renamed = await service.renameConversation(alice, conversation.id, {
        title: "  Client A resume  ",
      });
      expect(renamed.title).toBe("Client A resume");

      for (const title of ["", "   ", "x".repeat(101)]) {
        await expect(
          service.renameConversation(alice, conversation.id, { title }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });

    it("deletes the conversation and cascades to its messages", async () => {
      const { conversation } = await service.createConversation(alice, { message: "one" });
      await service.sendUserMessage(alice, conversation.id, { content: "two" });

      await service.deleteConversation(alice, conversation.id);

      expect(await db.conversation.count({ where: { id: conversation.id } })).toBe(0);
      expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(0);
      await expect(service.deleteConversation(alice, conversation.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
  describe("pinning", () => {
    it("lists pinned chats first (newest pin first) and can unpin", async () => {
      const a = await service.createConversation(alice, { message: "a" });
      const b = await service.createConversation(alice, { message: "b" });
      const c = await service.createConversation(alice, { message: "c" });

      expect(
        await service.setConversationPinned(alice, a.conversation.id, { pinned: true }),
      ).toMatchObject({ pinned: true });
      await service.setConversationPinned(alice, b.conversation.id, { pinned: true });
      const order = (await service.listConversations(alice)).items.map((item) => item.id);
      expect(order).toEqual([b.conversation.id, a.conversation.id, c.conversation.id]);

      await service.setConversationPinned(alice, b.conversation.id, { pinned: false });
      expect((await service.listConversations(alice)).items[0]!.id).toBe(a.conversation.id);

      await expect(
        service.setConversationPinned(bob, a.conversation.id, { pinned: false }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.setConversationPinned(alice, a.conversation.id, { pinned: "yes" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("message actions", () => {
    /** user → assistant → user → assistant, one second apart so the order is unambiguous. */
    async function thread() {
      const { conversation, message } = await service.createConversation(alice, {
        message: "first question",
      });
      const id = conversation.id;
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
      const reply1 = await db.message.create({
        data: { conversationId: id, role: "ASSISTANT", content: "first answer", createdAt: at(1) },
      });
      const user2 = await db.message.create({
        data: { conversationId: id, role: "USER", content: "second question", createdAt: at(2) },
      });
      const reply2 = await db.message.create({
        data: { conversationId: id, role: "ASSISTANT", content: "second answer", createdAt: at(3) },
      });
      return { id, user1: message!.id, reply1: reply1.id, user2: user2.id, reply2: reply2.id };
    }
    const contents = async (id: string) =>
      (
        await db.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } })
      ).map((message) => message.content);

    it("edit changes the user's message and removes everything after it", async () => {
      const t = await thread();
      const { message } = await service.editMessage(alice, t.id, t.user1, {
        content: "first question, edited",
      });
      expect(message).toMatchObject({ id: t.user1, content: "first question, edited" });
      expect(await contents(t.id)).toEqual(["first question, edited"]);
    });

    it("only the user's own messages can be edited, and not to empty text", async () => {
      const t = await thread();
      await expect(
        service.editMessage(alice, t.id, t.reply1, { content: "x" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.editMessage(alice, t.id, t.user1, { content: "   " }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.editMessage(bob, t.id, t.user1, { content: "hijack" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await contents(t.id)).toHaveLength(4);
    });

    it("retry on a user message keeps it and removes what followed", async () => {
      const t = await thread();
      const { message } = await service.prepareRetry(alice, t.id, t.user2);
      expect(message.id).toBe(t.user2);
      expect(await contents(t.id)).toEqual(["first question", "first answer", "second question"]);
    });

    it("regenerate on a reply removes that reply onwards and returns the question before it", async () => {
      const t = await thread();
      const { message } = await service.prepareRetry(alice, t.id, t.reply1);
      expect(message).toMatchObject({ id: t.user1, content: "first question" });
      expect(await contents(t.id)).toEqual(["first question"]);
    });

    it("delete removes only that message; another user cannot touch it", async () => {
      const t = await thread();
      await expect(service.deleteMessage(bob, t.id, t.reply1)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await service.deleteMessage(alice, t.id, t.reply1);
      expect(await contents(t.id)).toEqual(["first question", "second question", "second answer"]);
      await expect(service.deleteMessage(alice, t.id, "missing123")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("edit and delete discard the attachments of removed messages", async () => {
      const t = await thread();
      const file = await db.uploadedFile.create({
        data: {
          id: `f${Date.now().toString(16)}`,
          userId: alice,
          originalFilename: "cv.pdf",
          storageKey: `users/${alice}/uploads/f${Date.now().toString(16)}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 10,
          status: "UPLOADED",
        },
      });
      await db.messageAttachment.create({
        data: { messageId: t.user2, uploadedFileId: file.id, position: 0 },
      });

      const { discardedFileIds } = await service.editMessage(alice, t.id, t.user1, {
        content: "start over",
      });
      expect(discardedFileIds).toEqual([file.id]);
      expect(await db.uploadedFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
        status: "DELETED",
      });
    });
  });
});
