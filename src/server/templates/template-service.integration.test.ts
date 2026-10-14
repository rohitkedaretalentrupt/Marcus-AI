import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AIProvider, AnalyzeTemplateInput } from "@/lib/ai/types";
import { createFakeAIProvider } from "@test/fakes/fake-ai-provider";
import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";
import { makeEmptyPdf, makeTemplateDocx, makeTemplatePdf } from "@test/fixtures/make-documents";
import { SAMPLE_TEMPLATE_STRUCTURE } from "@test/fixtures/template-structure";

/**
 * Client template lifecycle against a REAL PostgreSQL database with real
 * PDF/DOCX bytes, the in-memory storage double and a MOCKED AI provider.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@templates.integration.example.test";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.skipIf(!TEST_DATABASE_URL)("client templates (PostgreSQL, mocked AI)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { AIProviderError } = await import("@/lib/ai/errors");
  const { NotFoundError, ValidationError } = await import("@/lib/errors/app-error");
  const files = await import("@/server/files/file-service");
  const chat = await import("@/server/chat/conversation-service");
  const service = await import("./template-service");

  const db = getDb();
  let storage: InMemoryStorageProvider;
  let calls: AnalyzeTemplateInput[];
  let alice: string;
  let bob: string;

  const okProvider = () =>
    createFakeAIProvider({
      modelName: "fake-mimo",
      analyzeTemplate: async (input) => {
        calls.push(input);
        return structuredClone(SAMPLE_TEMPLATE_STRUCTURE) as never;
      },
    });
  const deps = (provider: AIProvider = okProvider()) => ({
    getStorage: () => storage,
    getProvider: () => provider,
  });

  /** Upload through the real file service (purpose template) and confirm it. */
  async function uploadTemplateFile(
    userId: string,
    bytes: Uint8Array,
    mime = PDF,
    filename = "client.pdf",
  ) {
    const fileDeps = { getStorage: () => storage };
    const { file } = await files.requestUpload(
      userId,
      { filename, contentType: mime, sizeBytes: bytes.length, purpose: "template" },
      fileDeps,
    );
    const { storageKey } = await db.uploadedFile.findUniqueOrThrow({ where: { id: file.id } });
    storage.simulateBrowserUpload(storageKey, bytes, mime);
    await files.confirmUpload(userId, file.id, fileDeps);
    return { fileId: file.id, storageKey };
  }

  async function createAndRun(
    userId: string,
    name: string,
    bytes: Uint8Array,
    mime = PDF,
    provider?: AIProvider,
  ) {
    const { fileId, storageKey } = await uploadTemplateFile(
      userId,
      bytes,
      mime,
      mime === PDF ? "t.pdf" : "t.docx",
    );
    const created = await service.createTemplate(userId, { name, fileId });
    const result = await service.runTemplateAnalysis(userId, created.id, deps(provider));
    return { created, result, fileId, storageKey };
  }

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    await db.clientTemplate.deleteMany({ where: { userId: { in: [alice, bob] } } });
    storage = new InMemoryStorageProvider();
    calls = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it.each([
    ["PDF", PDF, makeTemplatePdf, "EXPERIENCE"],
    ["DOCX", DOCX, makeTemplateDocx, "Key Skills"],
  ] as const)(
    "analyses a %s template into a validated structure (original untouched)",
    async (_n, mime, make, heading) => {
      const bytes = await make();
      const { created, result, storageKey } = await createAndRun(
        alice,
        `Client ${_n}`,
        bytes,
        mime,
      );

      expect(created.status).toBe("PROCESSING");
      expect(result).toMatchObject({
        status: "READY",
        analyzedBy: "fake-mimo",
        failureMessage: null,
      });
      expect(result?.structure?.sections.map((s) => s.heading)).toEqual([
        "PROFESSIONAL SUMMARY",
        "EXPERIENCE",
        "EDUCATION",
      ]);

      // The AI received layout evidence — not the file, key or ids.
      expect(calls[0]!.digest).toContain(heading);
      expect(JSON.stringify(calls[0])).not.toContain(storageKey);
      // Original object is preserved byte-for-byte.
      expect(storage.objects.get(storageKey)?.bytes).toEqual(bytes);
      expect(storageKey).toMatch(
        new RegExp(`^users/${alice}/templates/[0-9a-f]{32}\\.(pdf|docx)$`),
      );
    },
  );

  it("records FAILED for scans, AI failures and invalid AI output — then retries successfully", async () => {
    const scan = await createAndRun(alice, "Scan", await makeEmptyPdf());
    expect(scan.result).toMatchObject({
      status: "FAILED",
      failureMessage: expect.stringMatching(/scanned/),
    });

    const down = createFakeAIProvider({
      analyzeTemplate: async () => {
        throw new AIProviderError("timeout", "timed out");
      },
    });
    const failed = await createAndRun(alice, "Flaky", await makeTemplatePdf(), PDF, down);
    expect(failed.result).toMatchObject({ status: "FAILED", structure: null });

    const invalid = createFakeAIProvider({
      analyzeTemplate: async () => {
        throw new AIProviderError("invalid_response", "bad json");
      },
    });
    const bad = await createAndRun(alice, "Bad", await makeTemplatePdf(), PDF, invalid);
    expect(bad.result?.failureMessage).toMatch(/unexpected result/);

    const retried = await service.retryTemplateAnalysis(alice, failed.created.id, deps());
    expect(retried.status).toBe("PROCESSING");
    await expect(
      service.runTemplateAnalysis(alice, failed.created.id, deps()),
    ).resolves.toMatchObject({
      status: "READY",
    });
    await expect(
      service.retryTemplateAnalysis(alice, failed.created.id, deps()),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it("validates creation: purpose, type, reuse, duplicate names", async () => {
    const { fileId } = await uploadTemplateFile(alice, await makeTemplatePdf());
    await service.createTemplate(alice, { name: "Client A", fileId });

    // Same file again / same name (case-insensitive) again
    await expect(service.createTemplate(alice, { name: "Other", fileId })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const second = await uploadTemplateFile(alice, await makeTemplatePdf());
    await expect(
      service.createTemplate(alice, { name: "client a", fileId: second.fileId }),
    ).rejects.toMatchObject({ status: 409 });

    // An attachment-purpose file cannot become a template
    const attachment = await files.requestUpload(
      alice,
      { filename: "cv.pdf", contentType: PDF, sizeBytes: 10 },
      { getStorage: () => storage },
    );
    await expect(
      service.createTemplate(alice, { name: "X", fileId: attachment.file.id }),
    ).rejects.toThrow();
  });

  it("saves templates while AI is not configured, then analyses them on retry", async () => {
    const { fileId } = await uploadTemplateFile(alice, await makeTemplatePdf());
    const noAI = {
      getStorage: () => storage,
      getProvider: (): AIProvider => {
        throw Object.assign(new Error("off"), { status: 503 });
      },
    };
    const created = await service.createTemplate(alice, { name: "Waiting", fileId });
    const waiting = await service.runTemplateAnalysis(alice, created.id, noAI);
    expect(waiting).toMatchObject({ status: "FAILED", awaitingAI: true, structure: null });
    expect(waiting?.failureMessage).toMatch(/once the AI service is configured/);
    expect(calls).toHaveLength(0);

    // Retrying while AI is still off is refused clearly (nothing is re-queued).
    await expect(service.retryTemplateAnalysis(alice, created.id, noAI)).rejects.toMatchObject({
      status: 503,
    });
    expect((await service.getTemplate(alice, created.id))?.awaitingAI).toBe(true);

    // Once AI is configured, a retry analyses the saved file.
    await service.retryTemplateAnalysis(alice, created.id, deps());
    expect(await service.runTemplateAnalysis(alice, created.id, deps())).toMatchObject({
      status: "READY",
      awaitingAI: false,
    });
  });

  it("enforces ownership on every operation", async () => {
    const { created, fileId } = await createAndRun(alice, "Private", await makeTemplatePdf());

    await expect(service.createTemplate(bob, { name: "Steal", fileId })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await service.getTemplate(bob, created.id)).toBeNull();
    expect(await service.listTemplates(bob)).toEqual([]);
    await expect(service.retryTemplateAnalysis(bob, created.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.deleteTemplate(bob, created.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await service.runTemplateAnalysis(bob, created.id, deps())).toBeNull();

    const { conversation } = await chat.createConversation(bob, { message: "hi" });
    await expect(
      service.selectConversationTemplate(bob, conversation.id, { templateId: created.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await service.getTemplate(alice, created.id)).toMatchObject({ name: "Private" });
  });

  it("a template's source file cannot be discarded directly (delete the template instead)", async () => {
    const { created, fileId } = await createAndRun(alice, "Guarded", await makeTemplatePdf());
    await expect(
      files.discardUpload(alice, fileId, { getStorage: () => storage }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.getTemplate(alice, created.id)).toMatchObject({ status: "READY" });
  });

  it("template files can never be attached to chat messages", async () => {
    const { fileId } = await uploadTemplateFile(alice, await makeTemplatePdf());
    const { conversation } = await chat.createConversation(alice, { message: "hi" });
    await expect(
      chat.sendUserMessage(alice, conversation.id, { content: "x", attachmentFileIds: [fileId] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("selects a READY template for a conversation and unlinks it when deleted", async () => {
    const { created, fileId, storageKey } = await createAndRun(
      alice,
      "Client B",
      await makeTemplatePdf(),
    );
    const { conversation } = await chat.createConversation(alice, { message: "hi" });

    await service.selectConversationTemplate(alice, conversation.id, { templateId: created.id });
    expect((await chat.getConversation(alice, conversation.id))?.clientTemplate).toEqual({
      id: created.id,
      name: "Client B",
    });
    expect(await service.templateContextFor(alice, conversation.id)).toEqual({
      availableTemplates: ["Client B"],
      selectedTemplate: "Client B",
    });

    await service.deleteTemplate(alice, created.id, deps());
    expect((await chat.getConversation(alice, conversation.id))?.clientTemplate).toBeNull();
    expect(await db.uploadedFile.count({ where: { id: fileId } })).toBe(0);
    expect(storage.deletedKeys).toContain(storageKey);
  });

  it("lists the user's templates without structure", async () => {
    await createAndRun(alice, "One", await makeTemplatePdf());
    const list = await service.listTemplates(alice);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("structure");
    expect(JSON.stringify(list)).not.toContain("users/");
  });
  describe("viewing the uploaded file", () => {
    it("returns a PDF template's original bytes, only to its owner", async () => {
      const preview = await import("./template-preview");
      const bytes = await makeTemplatePdf();
      const { created } = await createAndRun(alice, "Viewer PDF", bytes);

      const result = await preview.getTemplatePreview(alice, created.id, () => storage);
      expect(result.kind).toBe("pdf");
      expect(result.kind === "pdf" && Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(
        true,
      );
      await expect(
        preview.getTemplatePreview(bob, created.id, () => storage),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        preview.getTemplatePreview(alice, "not-an-id!", () => storage),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("converts a DOCX template to safe HTML", async () => {
      const preview = await import("./template-preview");
      const { created } = await createAndRun(alice, "Viewer DOCX", await makeTemplateDocx(), DOCX);
      const result = await preview.getTemplatePreview(alice, created.id, () => storage);
      expect(result.kind).toBe("docx");
      const html = result.kind === "docx" ? result.html : "";
      expect(html).toContain("Key Skills");
      expect(html).not.toMatch(/<script|<img|javascript:/i);
    });
  });
});
