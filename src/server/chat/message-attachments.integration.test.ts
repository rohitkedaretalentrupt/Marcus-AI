import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";

/**
 * Message ↔ file attachment rules against a REAL PostgreSQL database.
 * Files are inserted directly in the state each test needs.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@attachments.integration.example.test";

describe.skipIf(!TEST_DATABASE_URL)("message attachments (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { ValidationError } = await import("@/lib/errors/app-error");
  const chat = await import("./conversation-service");
  const files = await import("@/server/files/file-service");

  const db = getDb();
  let alice: string;
  let bob: string;
  let counter = 0;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  type FixtureStatus = "UPLOADED" | "PENDING_UPLOAD" | "FAILED" | "DELETED";

  async function file(
    userId: string,
    {
      status = "UPLOADED",
      sizeBytes = 1000,
      name = "resume.pdf",
    }: { status?: FixtureStatus; sizeBytes?: number; name?: string } = {},
  ) {
    const id = `f${Date.now().toString(16)}${(counter++).toString(16).padStart(6, "0")}`;
    await db.uploadedFile.create({
      data: {
        id,
        userId,
        originalFilename: name,
        storageKey: `users/${userId}/uploads/${id}.pdf`,
        mimeType: "application/pdf",
        sizeBytes,
        status,
      },
    });
    return id;
  }

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await db.uploadedFile.deleteMany({ where: { userId: { in: [alice, bob] } } });
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("stores messages without attachments as before", async () => {
    const { conversation } = await chat.createConversation(alice, { message: "Hello" });
    const message = await chat.sendUserMessage(alice, conversation.id, { content: "Text only" });
    expect(message.attachments).toEqual([]);
  });

  it("attaches one and multiple files in order, and they persist on reload", async () => {
    const pdf = await file(alice, { name: "resume.pdf" });
    const tpl = await file(alice, { name: "client-template.pdf" });
    const { conversation, message } = await chat.createConversation(alice, {
      message: "Use this template.",
      attachmentFileIds: [pdf],
    });
    expect(message?.attachments.map((a) => a.id)).toEqual([pdf]);

    const second = await chat.sendUserMessage(alice, conversation.id, {
      content: "And this one",
      attachmentFileIds: [tpl, await file(alice, { name: "photo.pdf" })],
    });
    expect(second.attachments.map((a) => a.filename)).toEqual(["client-template.pdf", "photo.pdf"]);

    const reloaded = await chat.getConversation(alice, conversation.id);
    expect(reloaded?.messages.map((m) => m.attachments.map((a) => a.filename))).toEqual([
      ["resume.pdf"],
      ["client-template.pdf", "photo.pdf"],
    ]);
    expect(JSON.stringify(reloaded)).not.toContain("storageKey");
    expect(JSON.stringify(reloaded)).not.toContain(`users/${alice}`);
  });

  it("allows an attachment-only message and titles the conversation from the file", async () => {
    const id = await file(alice, { name: "Jane Doe CV.pdf" });
    const { conversation, message } = await chat.createConversation(alice, {
      message: "",
      attachmentFileIds: [id],
    });
    expect(conversation.title).toBe("Jane Doe CV.pdf");
    expect(message?.content).toBe("");

    await expect(
      chat.sendUserMessage(alice, conversation.id, { content: "  ", attachmentFileIds: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("user A cannot attach user B's file", async () => {
    const bobsFile = await file(bob);
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });

    await expect(
      chat.sendUserMessage(alice, conversation.id, {
        content: "steal",
        attachmentFileIds: [bobsFile],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      chat.createConversation(alice, { message: "steal", attachmentFileIds: [bobsFile] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.messageAttachment.count({ where: { uploadedFileId: bobsFile } })).toBe(0);
  });

  it.each(["PENDING_UPLOAD", "FAILED", "DELETED"] as const)(
    "a %s file cannot be attached",
    async (status) => {
      const id = await file(alice, { status });
      const { conversation } = await chat.createConversation(alice, { message: "Hi" });
      await expect(
        chat.sendUserMessage(alice, conversation.id, { content: "x", attachmentFileIds: [id] }),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it("a file can only be attached to one message", async () => {
    const id = await file(alice);
    const { conversation } = await chat.createConversation(alice, {
      message: "first",
      attachmentFileIds: [id],
    });
    await expect(
      chat.sendUserMessage(alice, conversation.id, { content: "again", attachmentFileIds: [id] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("enforces the combined size limit atomically (no partial message)", async () => {
    const big = 20 * 1024 * 1024;
    const ids = [
      await file(alice, { sizeBytes: big }),
      await file(alice, { sizeBytes: big }),
      await file(alice, { sizeBytes: big }),
    ];
    const { conversation } = await chat.createConversation(alice, { message: "Hi" });

    await expect(
      chat.sendUserMessage(alice, conversation.id, { content: "too big", attachmentFileIds: ids }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1);
  });

  it("user B cannot read user A's attachments", async () => {
    const id = await file(alice);
    const { conversation } = await chat.createConversation(alice, {
      message: "private",
      attachmentFileIds: [id],
    });
    expect(await chat.getConversation(bob, conversation.id)).toBeNull();
  });

  it("deleting a conversation removes attachment links and purges the files", async () => {
    const ids = [await file(alice), await file(alice)];
    const { conversation } = await chat.createConversation(alice, {
      message: "with files",
      attachmentFileIds: ids,
    });

    const { discardedFileIds } = await chat.deleteConversation(alice, conversation.id);
    expect(discardedFileIds.sort()).toEqual([...ids].sort());
    expect(await db.messageAttachment.count({ where: { uploadedFileId: { in: ids } } })).toBe(0);
    expect(
      (await db.uploadedFile.findMany({ where: { id: { in: ids } } })).map((f) => f.status),
    ).toEqual(["DELETED", "DELETED"]);

    const storage = new InMemoryStorageProvider();
    await files.purgeDiscardedFiles(alice, discardedFileIds, { getStorage: () => storage });
    expect(storage.deletedKeys).toHaveLength(2);
    expect(await db.uploadedFile.count({ where: { id: { in: ids } } })).toBe(0);
  });

  it("an attached file cannot be discarded on its own", async () => {
    const id = await file(alice);
    await chat.createConversation(alice, { message: "sent", attachmentFileIds: [id] });
    const storage = new InMemoryStorageProvider();
    await expect(
      files.discardUpload(alice, id, { getStorage: () => storage }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(storage.deletedKeys).toEqual([]);
  });

  it("deleting a user cascades through conversations, attachments and files", async () => {
    const temp = (await db.user.create({ data: { email: `temp${EMAIL_DOMAIN}` } })).id;
    const id = await file(temp);
    await chat.createConversation(temp, { message: "x", attachmentFileIds: [id] });

    await db.user.delete({ where: { id: temp } });
    expect(await db.uploadedFile.count({ where: { id } })).toBe(0);
  });
});
