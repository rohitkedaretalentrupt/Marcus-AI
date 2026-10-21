import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";
import {
  makeDocx,
  makeEmptyPdf,
  makePdf,
  SAMPLE_RESUME_LINES,
} from "@test/fixtures/make-documents";

/**
 * Extraction lifecycle against a REAL PostgreSQL database with real PDF/DOCX
 * bytes. Object storage is the in-memory test double (live R2 not exercised).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@extraction.integration.example.test";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.skipIf(!TEST_DATABASE_URL)("resume extraction (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { NotFoundError } = await import("@/lib/errors/app-error");
  const service = await import("./extraction-service");
  const chat = await import("@/server/chat/conversation-service");

  const db = getDb();
  let storage: InMemoryStorageProvider;
  let deps: { getStorage: () => InMemoryStorageProvider };
  let alice: string;
  let bob: string;
  let counter = 0;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  /** An UPLOADED file whose bytes are in (fake) storage. */
  async function uploadedFile(userId: string, bytes: Uint8Array, mimeType: string) {
    const id = `e${Date.now().toString(16)}${(counter++).toString(16).padStart(6, "0")}`;
    const storageKey = `users/${userId}/uploads/${id}.${mimeType === PDF ? "pdf" : "docx"}`;
    await db.uploadedFile.create({
      data: {
        id,
        userId,
        originalFilename: "resume",
        storageKey,
        mimeType,
        sizeBytes: bytes.length,
        status: "UPLOADED",
      },
    });
    storage.simulateBrowserUpload(storageKey, bytes, mimeType);
    return id;
  }

  async function extract(userId: string, fileId: string) {
    await service.startResumeExtraction(userId, fileId);
    return service.runResumeExtraction(userId, fileId, deps);
  }

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    deps = { getStorage: () => storage };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it.each([
    ["PDF", PDF, makePdf],
    ["DOCX", DOCX, makeDocx],
  ] as const)(
    "extracts a %s into validated ResumeContent and marks it READY",
    async (_n, mime, make) => {
      const fileId = await uploadedFile(alice, await make(SAMPLE_RESUME_LINES), mime);

      const claim = await service.startResumeExtraction(alice, fileId);
      expect(claim.status).toBe("PROCESSING");
      expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: fileId } })).status).toBe(
        "PROCESSING",
      );

      const result = await service.runResumeExtraction(alice, fileId, deps);
      expect(result).toMatchObject({ status: "READY", failureMessage: null });
      expect(result?.content?.contact).toMatchObject({
        fullName: "Sam Rivera",
        email: "sam.rivera@example.test",
      });
      expect(result?.content?.sections.map((s) => s.kind)).toEqual([
        "experience",
        "education",
        "skills",
      ]);

      const row = await db.resumeExtraction.findUniqueOrThrow({
        where: { uploadedFileId: fileId },
      });
      expect(row.rawText).toContain("Contoso Health");
      expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: fileId } })).status).toBe(
        "READY",
      );
      // The source object is preserved, untouched.
      expect(storage.deletedKeys).toEqual([]);
      expect(storage.objects.size).toBe(1);
    },
  );

  it("records FAILED (no_text) for a PDF without a text layer, and keeps the file usable", async () => {
    const fileId = await uploadedFile(alice, await makeEmptyPdf(), PDF);
    const result = await extract(alice, fileId);

    expect(result).toMatchObject({ status: "FAILED", content: null });
    expect(result?.failureMessage).toMatch(/scanned image/);
    expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: fileId } })).status).toBe(
      "UPLOADED",
    );

    // Still attachable to a message despite the failed extraction.
    const { message } = await chat.createConversation(alice, {
      message: "x",
      attachmentFileIds: [fileId],
    });
    expect(message?.attachments[0]).toMatchObject({ id: fileId, extractionStatus: "FAILED" });
  });

  it("records FAILED (unreadable) for a corrupt document", async () => {
    const fileId = await uploadedFile(alice, new TextEncoder().encode("%PDF-1.7 broken"), PDF);
    expect(await extract(alice, fileId)).toMatchObject({
      status: "FAILED",
      failureMessage: expect.stringMatching(/couldn't be read/),
    });
  });

  it("records FAILED (storage_error) when the source object is missing", async () => {
    const fileId = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    storage.objects.clear();
    expect(await extract(alice, fileId)).toMatchObject({ status: "FAILED" });
  });

  it("can be retried after a failure", async () => {
    const bytes = await makePdf(SAMPLE_RESUME_LINES);
    const fileId = await uploadedFile(alice, bytes, PDF);
    const key = (await db.uploadedFile.findUniqueOrThrow({ where: { id: fileId } })).storageKey;
    storage.objects.clear();
    expect(await extract(alice, fileId)).toMatchObject({ status: "FAILED" });

    storage.simulateBrowserUpload(key, bytes, PDF);
    expect(await extract(alice, fileId)).toMatchObject({ status: "READY" });
  });

  it("refreshes a reading made by an older parser in place, staying READY", async () => {
    const fileId = await uploadedFile(alice, await makeDocx(SAMPLE_RESUME_LINES), DOCX);
    await extract(alice, fileId);
    // Pretend it was read by an older parser version, from text with a sentence under Skills.
    await db.resumeExtraction.update({
      where: { uploadedFileId: fileId },
      data: {
        parserVersion: 1,
        rawText: [
          "Sam Rivera",
          "sam@example.test",
          "",
          "Skills",
          "Roadmapping, Stakeholder Management",
          "Led post-merger consolidation across Canada, the U.S., and Mexico.",
        ].join("\n"),
      },
    });

    await service.refreshOutdatedExtraction(alice, fileId);

    const row = await db.resumeExtraction.findUniqueOrThrow({ where: { uploadedFileId: fileId } });
    const { PARSER_VERSION } = await import("@/lib/resumes/parse-resume");
    expect(row).toMatchObject({ status: "READY", parserVersion: PARSER_VERSION });
    const skills = (
      row.content as { sections: { title: string; entries: { bullets: string[] }[] }[] }
    ).sections.find((section) => section.title === "Skills");
    expect(skills?.entries[0]?.bullets).toContain(
      "Led post-merger consolidation across Canada, the U.S., and Mexico.",
    );
    // Reading it again changes nothing.
    await service.refreshOutdatedExtraction(alice, fileId);
    expect(
      (await db.resumeExtraction.findUniqueOrThrow({ where: { uploadedFileId: fileId } }))
        .parserVersion,
    ).toBe(PARSER_VERSION);
  });

  it("does not start a duplicate run while one is in progress", async () => {
    const fileId = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    const first = await service.startResumeExtraction(alice, fileId);
    const second = await service.startResumeExtraction(alice, fileId);
    expect(second.startedAt).toBe(first.startedAt);
  });

  it("a superseded (stale) run cannot overwrite a newer claim", async () => {
    const fileId = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    await service.startResumeExtraction(alice, fileId);
    // Simulate the first claim going stale, then a new claim being made.
    await db.resumeExtraction.update({
      where: { uploadedFileId: fileId },
      data: { startedAt: new Date(Date.now() - service.STALE_PROCESSING_MS - 1000) },
    });
    const fresh = await service.startResumeExtraction(alice, fileId);
    expect(new Date(fresh.startedAt).getTime()).toBeGreaterThan(Date.now() - 10_000);

    await service.runResumeExtraction(alice, fileId, deps); // runs under the fresh claim
    expect((await service.getResumeExtraction(alice, fileId))?.status).toBe("READY");
  });

  it("refuses images (no OCR) and unverified files", async () => {
    const image = await uploadedFile(alice, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
    await expect(service.startResumeExtraction(alice, image)).rejects.toMatchObject({
      status: 415,
    });

    const pending = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    await db.uploadedFile.update({ where: { id: pending }, data: { status: "PENDING_UPLOAD" } });
    await expect(service.startResumeExtraction(alice, pending)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("enforces ownership: another user cannot start, run or read an extraction", async () => {
    const fileId = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    await extract(alice, fileId);

    await expect(service.startResumeExtraction(bob, fileId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await service.runResumeExtraction(bob, fileId, deps)).toBeNull();
    expect(await service.getResumeExtraction(bob, fileId)).toBeNull();
    expect(await service.getResumeExtraction(alice, fileId)).toMatchObject({ status: "READY" });
  });

  it("removes the extraction with its file (cascade)", async () => {
    const fileId = await uploadedFile(alice, await makePdf(SAMPLE_RESUME_LINES), PDF);
    await extract(alice, fileId);
    await db.uploadedFile.delete({ where: { id: fileId } });
    expect(await db.resumeExtraction.count({ where: { uploadedFileId: fileId } })).toBe(0);
  });
});
