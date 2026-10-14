import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";

/**
 * Storage cleanup against a REAL PostgreSQL database and the in-memory
 * storage double. Verifies what is removed — and that user-visible files
 * (attachments, template sources, recent uploads) are never touched.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@cleanup.integration.example.test";
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("storage cleanup (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { runStorageCleanup } = await import("./storage-cleanup");
  const db = getDb();
  let storage: InMemoryStorageProvider;
  let userId: string;
  let counter = 0;

  async function file(
    status: "PENDING_UPLOAD" | "UPLOADED" | "DELETED" | "FAILED",
    ageMs: number,
    extra: { purpose?: "ATTACHMENT" | "TEMPLATE" } = {},
  ) {
    const id = `c${Date.now().toString(16)}${(counter++).toString(16).padStart(6, "0")}`;
    const storageKey = `users/${userId}/uploads/${id}.pdf`;
    const at = new Date(Date.now() - ageMs);
    await db.uploadedFile.create({
      data: {
        id,
        userId,
        originalFilename: "f.pdf",
        storageKey,
        mimeType: "application/pdf",
        sizeBytes: 3,
        status,
        purpose: extra.purpose ?? "ATTACHMENT",
        createdAt: at,
      },
    });
    // updatedAt is set by Prisma; age it explicitly.
    await db.$executeRaw`UPDATE uploaded_files SET "updatedAt" = ${at} WHERE id = ${id}`;
    storage.simulateBrowserUpload(storageKey, new Uint8Array([1, 2, 3]), "application/pdf");
    return { id, storageKey };
  }
  const exists = async (id: string) => (await db.uploadedFile.count({ where: { id } })) === 1;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  beforeAll(async () => {
    await cleanup();
    userId = (await db.user.create({ data: { email: `owner${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    await db.uploadedFile.deleteMany({ where: { userId } });
    storage = new InMemoryStorageProvider();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("removes abandoned, deleted and failed uploads (objects first), and nothing else", async () => {
    const abandoned = await file("PENDING_UPLOAD", 3 * HOUR);
    const freshPending = await file("PENDING_UPLOAD", 60_000);
    const deleted = await file("DELETED", HOUR);
    const failed = await file("FAILED", 2 * 24 * HOUR);
    const recentFailed = await file("FAILED", HOUR);
    const uploaded = await file("UPLOADED", 90 * 24 * HOUR);

    // A sent attachment and a template source are never touched, even if marked DELETED.
    const conversation = await db.conversation.create({ data: { userId, title: "t" } });
    const message = await db.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "x" },
    });
    const attached = await file("DELETED", HOUR);
    await db.messageAttachment.create({
      data: { messageId: message.id, uploadedFileId: attached.id, position: 0 },
    });
    const templateSource = await file("DELETED", HOUR, { purpose: "TEMPLATE" });
    await db.clientTemplate.create({
      data: { userId, uploadedFileId: templateSource.id, name: "T", nameKey: "t" },
    });

    const result = await runStorageCleanup({ getStorage: () => storage });
    expect(result).toEqual({ abandonedUploads: 1, deletedFiles: 1, failedUploads: 1, errors: 0 });

    for (const gone of [abandoned, deleted, failed]) {
      expect(await exists(gone.id)).toBe(false);
      expect(storage.deletedKeys).toContain(gone.storageKey);
    }
    for (const kept of [freshPending, recentFailed, uploaded, attached, templateSource]) {
      expect(await exists(kept.id)).toBe(true);
      expect(storage.deletedKeys).not.toContain(kept.storageKey);
    }
  });

  it("keeps the row (to retry later) when the object cannot be deleted", async () => {
    const deleted = await file("DELETED", HOUR);
    storage.delete = async () => {
      throw new Error("R2 down");
    };
    const result = await runStorageCleanup({ getStorage: () => storage });
    expect(result).toMatchObject({ deletedFiles: 0, errors: 1 });
    expect(await exists(deleted.id)).toBe(true);
  });
});
