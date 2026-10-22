import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AIProvider, FormatResumeInput } from "@/lib/ai/types";
import type { DocumentRenderer } from "@/lib/documents/types";
import { createFakeAIProvider } from "@test/fakes/fake-ai-provider";
import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";
import { makeDocx, makeTemplatePdf, SAMPLE_RESUME_LINES } from "@test/fixtures/make-documents";
import { SAMPLE_TEMPLATE_STRUCTURE } from "@test/fixtures/template-structure";

/**
 * Formatting pipeline against a REAL PostgreSQL database with real DOCX/PDF
 * bytes, the real extraction + template services, the real DOCX renderer,
 * the in-memory storage double (live R2 not exercised) and a MOCKED AI.
 *
 *   READY resume → READY template → mocked MiMo plan → DOCX → storage + row → COMPLETED
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@formatting.integration.example.test";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Plan for the resume extracted from SAMPLE_RESUME_LINES (Experience s0, Education s1, Skills s2). */
const PLAN = {
  version: 1,
  header: { fields: ["fullName", "headline", "email", "phone", "location"] },
  sections: [
    { heading: "PROFESSIONAL SUMMARY", kind: "summary", layout: "paragraph", sources: ["summary"] },
    { heading: "EXPERIENCE", kind: "experience", sources: ["s0"] },
    { heading: "EDUCATION", kind: "education", sources: ["s1"] },
    { heading: "Skills", kind: "skills", layout: "inline", sources: ["s2"] },
  ],
  typography: { bodyFont: "Arial" },
};
const withoutSkills = { ...PLAN, sections: PLAN.sections.slice(0, 3) };
/** The sample template has no Skills section, so Skills always goes under "Additional Information". */
const SKILLS_EXTRA =
  'Content the template has no section for (Skills) was added under "Additional Information" at the end.';

describe.skipIf(!TEST_DATABASE_URL)("resume formatting (PostgreSQL, mocked AI)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { AIProviderError } = await import("@/lib/ai/errors");
  const { NotFoundError, ValidationError } = await import("@/lib/errors/app-error");
  const { createDocxRenderer } = await import("@/lib/documents/docx/docx-renderer");
  const { documentXmlText } = await import("@/lib/documents/docx/docx-validation");
  const files = await import("@/server/files/file-service");
  const extraction = await import("@/server/resumes/extraction-service");
  const templates = await import("@/server/templates/template-service");
  const chat = await import("@/server/chat/conversation-service");
  const service = await import("./formatting-service");

  const db = getDb();
  let storage: InMemoryStorageProvider;
  let calls: FormatResumeInput[];
  let alice: string;
  let bob: string;

  const planner = (...plans: unknown[]) =>
    createFakeAIProvider({
      modelName: "fake-mimo",
      analyzeTemplate: async () => structuredClone(SAMPLE_TEMPLATE_STRUCTURE) as never,
      formatResume: async (input) => {
        calls.push(input);
        const { aiFormattingPlanSchema } = await import("@/lib/formatting/plan");
        return aiFormattingPlanSchema.parse(plans[Math.min(calls.length - 1, plans.length - 1)]);
      },
    });
  const failing = (error: Error) =>
    createFakeAIProvider({
      formatResume: async () => {
        throw error;
      },
    });
  const deps = (provider: AIProvider = planner(PLAN), renderer?: DocumentRenderer) => ({
    getStorage: () => storage,
    getProvider: () => provider,
    getRenderer: () => renderer ?? createDocxRenderer(),
  });

  /** A resume uploaded as a chat attachment and extracted (READY). */
  async function readyResume(userId: string) {
    const bytes = await makeDocx(SAMPLE_RESUME_LINES);
    const fileDeps = { getStorage: () => storage };
    const { file } = await files.requestUpload(
      userId,
      { filename: "sam-cv.docx", contentType: DOCX, sizeBytes: bytes.length },
      fileDeps,
    );
    const { storageKey } = await db.uploadedFile.findUniqueOrThrow({ where: { id: file.id } });
    storage.simulateBrowserUpload(storageKey, bytes, DOCX);
    await files.confirmUpload(userId, file.id, fileDeps);
    await extraction.startResumeExtraction(userId, file.id);
    const result = await extraction.runResumeExtraction(userId, file.id, fileDeps);
    expect(result?.status).toBe("READY");
    return { fileId: file.id, storageKey, bytes };
  }

  /** A client template uploaded and analysed (READY). */
  async function readyTemplate(userId: string, name = "Client A") {
    const bytes = await makeTemplatePdf();
    const fileDeps = { getStorage: () => storage };
    const { file } = await files.requestUpload(
      userId,
      {
        filename: "client.pdf",
        contentType: "application/pdf",
        sizeBytes: bytes.length,
        purpose: "template",
      },
      fileDeps,
    );
    const { storageKey } = await db.uploadedFile.findUniqueOrThrow({ where: { id: file.id } });
    storage.simulateBrowserUpload(storageKey, bytes, "application/pdf");
    await files.confirmUpload(userId, file.id, fileDeps);
    const templateDeps = { getStorage: () => storage, getProvider: () => planner(PLAN) };
    const created = await templates.createTemplate(userId, { name, fileId: file.id });
    const result = await templates.runTemplateAnalysis(userId, created.id, templateDeps);
    expect(result?.status).toBe("READY");
    return { templateId: created.id, storageKey, bytes };
  }

  async function createJob(userId: string, resumeFileId: string, templateId: string) {
    const { job, created } = await service.createFormattingJob(
      userId,
      { resumeFileId, templateId },
      deps(),
    );
    expect(created).toBe(true);
    return job;
  }

  const docText = async (bytes: Uint8Array) =>
    documentXmlText(
      await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string"),
    );

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    await db.formattingJob.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await db.clientTemplate.deleteMany({ where: { userId: { in: [alice, bob] } } });
    storage = new InMemoryStorageProvider();
    calls = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("formats end to end: READY resume + READY template → plan → DOCX → storage → COMPLETED", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    expect(job).toMatchObject({ status: "QUEUED", document: null, canRetry: false });

    const done = await service.runFormattingJob(alice, job.id, deps());
    expect(done).toMatchObject({
      status: "COMPLETED",
      failureMessage: null,
      warnings: [SKILLS_EXTRA],
      aiModel: "fake-mimo",
      engineVersion: 3,
      resume: { fileId: resume.fileId, filename: "sam-cv.docx" },
      template: { id: template.templateId, name: "Client A" },
      document: { filename: "Sam Rivera - Client A.docx" },
    });

    // The AI got the template structure and the resume — never storage keys.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.template.sections[1]!.heading).toBe("EXPERIENCE");
    expect(JSON.stringify(calls[0])).not.toContain("users/");

    // Private, server-generated key; metadata only in PostgreSQL.
    const row = await db.generatedDocument.findFirstOrThrow({ where: { formattingJobId: job.id } });
    expect(row).toMatchObject({ userId: alice, mimeType: DOCX });
    expect(row.storageKey).toMatch(new RegExp(`^users/${alice}/generated/[0-9a-f]{32}\\.docx$`));
    expect(storage.putKeys).toEqual([row.storageKey]);
    const stored = storage.objects.get(row.storageKey)!;
    expect(stored.contentType).toBe(DOCX);
    expect(row.sizeBytes).toBe(stored.bytes.length);

    // Content preserved, template headings applied.
    const text = await docText(stored.bytes);
    for (const fact of [
      "Sam Rivera",
      "Contoso Health",
      "Feb 2021",
      "Built 30 operational dashboards",
      "B.S. Statistics",
      "2018",
      "Tableau",
    ]) {
      expect(text).toContain(fact);
    }
    expect(text).toContain("PROFESSIONAL SUMMARY");

    // Versioning metadata and the validated plan are stored; originals untouched.
    const stored_job = await db.formattingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored_job).toMatchObject({ attempts: 1, activeKey: null, resumeParserVersion: 5 });
    expect(stored_job.templateAnalyzedAt).toBeInstanceOf(Date);
    expect(stored_job.plan).toMatchObject({
      source: { resumeFileId: resume.fileId, templateId: template.templateId, engineVersion: 3 },
      page: { size: "a4" },
    });
    expect(storage.objects.get(resume.storageKey)?.bytes).toEqual(resume.bytes);
    expect(storage.objects.get(template.storageKey)?.bytes).toEqual(template.bytes);

    // Download: signed URL for the owner's object with a safe filename.
    const download = await service.createFormattedDownloadUrl(alice, job.id, deps());
    expect(download.url).toContain(row.storageKey);
    expect(download.filename).toBe("Sam Rivera - Client A.docx");

    // Preview: the owner's generated DOCX, read through the server; nobody else's.
    const preview = await service.readFormattedResume(alice, job.id, deps());
    expect(
      Buffer.from(preview.bytes).equals(Buffer.from(storage.objects.get(row.storageKey)!.bytes)),
    ).toBe(true);
    expect(preview.mimeType).toContain("wordprocessingml.document");
    await expect(service.readFormattedResume(bob, job.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const { ServiceUnavailableError } = await import("@/lib/errors/app-error");
    const storageOff = {
      getStorage: () => {
        throw new ServiceUnavailableError("File uploads aren't available right now.");
      },
    };
    await expect(
      service.createFormattedDownloadUrl(alice, job.id, storageOff),
    ).rejects.toMatchObject({
      status: 503,
      publicMessage: "Downloads aren't available right now.",
    });
  });

  it("requests one controlled correction when content is missing, then completes", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    const done = await service.runFormattingJob(alice, job.id, deps(planner(withoutSkills, PLAN)));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.correction?.issues).toContain('Content "s2.e0" is not placed in any section.');
    expect(done).toMatchObject({ status: "COMPLETED", warnings: [SKILLS_EXTRA] });
  });

  it("never produces an incomplete resume: still-missing content is placed and reported", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    const done = await service.runFormattingJob(alice, job.id, deps(planner(withoutSkills)));

    expect(calls).toHaveLength(2);
    expect(done).toMatchObject({
      status: "COMPLETED",
      warnings: ['Some content from "Skills" was placed automatically.', SKILLS_EXTRA],
    });
    const row = await db.generatedDocument.findFirstOrThrow({ where: { formattingJobId: job.id } });
    expect(await docText(storage.objects.get(row.storageKey)!.bytes)).toContain("Tableau");
  });

  it.each([
    [
      "invalid AI output",
      new AIProviderError("invalid_response", "bad"),
      "unusable formatting plan",
    ],
    ["an AI timeout", new AIProviderError("timeout", "slow"), "took too long"],
    ["an AI outage", new AIProviderError("unavailable", "down"), "isn't available"],
  ])("fails safely on %s, stores nothing, and can be retried", async (_name, error, message) => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);

    const failed = await service.runFormattingJob(alice, job.id, deps(failing(error)));
    expect(failed).toMatchObject({ status: "FAILED", document: null, canRetry: true });
    expect(failed?.failureMessage).toContain(message);
    expect(storage.putKeys).toEqual([]);
    expect(await db.formattingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      activeKey: null,
      plan: null,
    });

    expect(await service.retryFormattingJob(alice, job.id, deps())).toMatchObject({
      status: "QUEUED",
    });
    expect(await service.runFormattingJob(alice, job.id, deps())).toMatchObject({
      status: "COMPLETED",
    });
    expect(await db.formattingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      attempts: 2,
    });
    await expect(service.retryFormattingJob(alice, job.id, deps())).rejects.toMatchObject({
      status: 409,
    });
  });

  it("fails generation safely: renderer errors, invalid DOCX, missing content, storage errors", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const run = async (renderer?: DocumentRenderer, prepare?: () => void) => {
      await db.formattingJob.deleteMany({ where: { userId: alice } });
      const job = await createJob(alice, resume.fileId, template.templateId);
      prepare?.();
      return service.runFormattingJob(alice, job.id, deps(planner(PLAN), renderer));
    };
    const real = createDocxRenderer();
    const broken: DocumentRenderer = {
      format: "docx",
      render: async () => {
        throw new Error("boom");
      },
    };
    const garbage: DocumentRenderer = {
      format: "docx",
      render: async () => ({ format: "docx", mimeType: DOCX, data: new Uint8Array([1, 2, 3]) }),
    };
    const lossy: DocumentRenderer = {
      format: "docx",
      render: async ({ content, plan }) => {
        const dropped = structuredClone(content);
        dropped.sections[0]!.entries[0]!.bullets = [];
        return real.render({ content: dropped, plan });
      },
    };

    expect((await run(broken))?.failureMessage).toContain("couldn't be generated");
    expect((await run(garbage))?.failureMessage).toContain("quality checks");
    expect((await run(lossy))?.failureMessage).toContain("quality checks");
    expect((await run(undefined, () => (storage.failNextPut = true)))?.failureMessage).toContain(
      "couldn't be saved",
    );
    expect(await db.generatedDocument.count({ where: { userId: alice } })).toBe(0);
    expect(storage.putKeys).toEqual([]);
  });

  it("an older run never overwrites a newer claim (its output is discarded)", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    const hijack = createFakeAIProvider({
      formatResume: async () => {
        // A newer run re-claims the job while this one is still planning.
        await db.formattingJob.update({ where: { id: job.id }, data: { startedAt: new Date(0) } });
        const { aiFormattingPlanSchema } = await import("@/lib/formatting/plan");
        return aiFormattingPlanSchema.parse(PLAN);
      },
    });

    const result = await service.runFormattingJob(alice, job.id, deps(hijack));
    expect(result?.status).toBe("PROCESSING"); // untouched by the stale run
    expect(await db.generatedDocument.count({ where: { formattingJobId: job.id } })).toBe(0);
    expect(storage.putKeys).toHaveLength(1);
    expect(storage.deletedKeys).toEqual(storage.putKeys); // its object was removed
  });

  it("prevents duplicate jobs and replaces stuck ones", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const input = { resumeFileId: resume.fileId, templateId: template.templateId };

    const results = await Promise.all([
      service.createFormattingJob(alice, input, deps()),
      service.createFormattingJob(alice, input, deps()),
      service.createFormattingJob(alice, input, deps()),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);

    // A job stuck in QUEUED (e.g. lost on restart) is failed and replaced.
    const stuckId = results[0]!.job.id;
    await db.$executeRaw`UPDATE formatting_jobs SET "updatedAt" = now() - interval '1 hour' WHERE id = ${stuckId}`;
    const replaced = await service.createFormattingJob(alice, input, deps());
    expect(replaced.created).toBe(true);
    expect(await service.getFormattingJob(alice, stuckId)).toMatchObject({ status: "FAILED" });

    // Once finished, the same pair can be formatted again.
    await service.runFormattingJob(alice, replaced.job.id, deps());
    expect((await service.createFormattingJob(alice, input, deps())).created).toBe(true);
  });

  it("validates the resume and template (missing, not ready, wrong kind, AI off)", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const create = (input: object, d: object = deps()) =>
      service.createFormattingJob(alice, input, d as never);

    await expect(
      create({ resumeFileId: "nope", templateId: template.templateId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      create({ resumeFileId: resume.fileId, templateId: "nope" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(create({ resumeFileId: resume.fileId })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      create({ resumeFileId: resume.fileId, templateId: template.templateId, extra: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    // A template's own file is not a resume.
    const templateFile = await db.clientTemplate.findUniqueOrThrow({
      where: { id: template.templateId },
    });
    await expect(
      create({ resumeFileId: templateFile.uploadedFileId, templateId: template.templateId }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await db.clientTemplate.update({
      where: { id: template.templateId },
      data: { status: "FAILED" },
    });
    await expect(
      create({ resumeFileId: resume.fileId, templateId: template.templateId }),
    ).rejects.toBeInstanceOf(ValidationError);
    await db.clientTemplate.update({
      where: { id: template.templateId },
      data: { status: "READY" },
    });

    await db.resumeExtraction.update({
      where: { uploadedFileId: resume.fileId },
      data: { status: "FAILED" },
    });
    await expect(
      create({ resumeFileId: resume.fileId, templateId: template.templateId }),
    ).rejects.toBeInstanceOf(ValidationError);
    await db.resumeExtraction.update({
      where: { uploadedFileId: resume.fileId },
      data: { status: "READY" },
    });

    const noAI = {
      getStorage: () => storage,
      getProvider: () => {
        throw Object.assign(new Error("off"), { status: 503 });
      },
    };
    await expect(
      create({ resumeFileId: resume.fileId, templateId: template.templateId }, noAI),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("fails with a clear reason if the resume or template disappears before processing", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    await templates.deleteTemplate(alice, template.templateId, { getStorage: () => storage });

    const failed = await service.runFormattingJob(alice, job.id, deps());
    expect(failed).toMatchObject({ status: "FAILED", template: null, canRetry: false });
    expect(failed?.failureMessage).toContain("template is no longer available");
    await expect(service.retryFormattingJob(alice, job.id, deps())).rejects.toMatchObject({
      status: 409,
    });

    const second = await createJob(
      alice,
      resume.fileId,
      (await readyTemplate(alice, "Client B")).templateId,
    );
    await db.resumeExtraction.update({
      where: { uploadedFileId: resume.fileId },
      data: { status: "FAILED" },
    });
    expect((await service.runFormattingJob(alice, second.id, deps()))?.failureMessage).toContain(
      "resume is no longer available",
    );
  });

  it("isolates users: no access to another user's jobs, resumes, templates or documents", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    const job = await createJob(alice, resume.fileId, template.templateId);
    await service.runFormattingJob(alice, job.id, deps());

    const bobTemplate = await readyTemplate(bob, "Bob's");
    const bobResume = await readyResume(bob);
    await expect(
      service.createFormattingJob(
        bob,
        { resumeFileId: resume.fileId, templateId: bobTemplate.templateId },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.createFormattingJob(
        bob,
        { resumeFileId: bobResume.fileId, templateId: template.templateId },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await service.getFormattingJob(bob, job.id)).toBeNull();
    expect(await service.listFormattingJobs(bob)).toEqual([]);
    expect((await service.listFormattableResumes(bob)).map((r) => r.fileId)).toEqual([
      bobResume.fileId,
    ]);
    await expect(service.retryFormattingJob(bob, job.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.deleteFormattingJob(bob, job.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.createFormattedDownloadUrl(bob, job.id, deps())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await service.runFormattingJob(bob, job.id, deps())).toBeNull();
    expect(await service.getFormattingJob(alice, job.id)).toMatchObject({ status: "COMPLETED" });
  });

  it("lists formattable resumes and deletes a job with its document", async () => {
    const resume = await readyResume(alice);
    const template = await readyTemplate(alice);
    expect(await service.listFormattableResumes(alice)).toContainEqual(
      expect.objectContaining({ fileId: resume.fileId, candidateName: "Sam Rivera" }),
    );
    const job = await createJob(alice, resume.fileId, template.templateId);
    await expect(service.deleteFormattingJob(alice, job.id, deps())).rejects.toMatchObject({
      status: 409,
    });
    await service.runFormattingJob(alice, job.id, deps());
    const { storageKey } = await db.generatedDocument.findFirstOrThrow({
      where: { formattingJobId: job.id },
    });

    const views = await service.listFormattingJobs(alice);
    expect(views.map((view) => view.id)).toEqual([job.id]);
    expect(JSON.stringify(views)).not.toContain("users/");

    await service.deleteFormattingJob(alice, job.id, deps());
    expect(storage.deletedKeys).toContain(storageKey);
    expect(await db.generatedDocument.count({ where: { formattingJobId: job.id } })).toBe(0);
    expect(await service.getFormattingJob(alice, job.id)).toBeNull();
  });
  describe("resource limits", () => {
    it("refuses resumes that are too large for the AI input limit (no truncation)", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const extractionRow = await db.resumeExtraction.findUniqueOrThrow({
        where: { uploadedFileId: resume.fileId },
      });
      const content = structuredClone(extractionRow.content) as {
        sections: { entries: { bullets: string[] }[] }[];
      };
      content.sections[0]!.entries[0]!.bullets = Array.from({ length: 50 }, (_, i) =>
        `Synthetic achievement ${i} `.padEnd(999, "x"),
      );
      content.sections.push(
        ...Array.from({ length: 2 }, () => structuredClone(content.sections[0]!)),
      );
      await db.resumeExtraction.update({
        where: { uploadedFileId: resume.fileId },
        data: { content: content as never },
      });

      const job = await createJob(alice, resume.fileId, template.templateId);
      const result = await service.runFormattingJob(alice, job.id, deps());
      expect(result?.failureMessage).toContain("too long to format automatically");
      expect(calls).toHaveLength(0); // the AI was never called
    });

    it("limits how many jobs one user can run at once", async () => {
      const template = await readyTemplate(alice);
      const resumes = [];
      for (let i = 0; i <= service.MAX_ACTIVE_JOBS_PER_USER; i++)
        resumes.push(await readyResume(alice));
      for (const resume of resumes.slice(0, service.MAX_ACTIVE_JOBS_PER_USER)) {
        await createJob(alice, resume.fileId, template.templateId);
      }
      await expect(
        service.createFormattingJob(
          alice,
          { resumeFileId: resumes.at(-1)!.fileId, templateId: template.templateId },
          deps(),
        ),
      ).rejects.toMatchObject({ status: 429 });
      // Other users are unaffected.
      const bobResume = await readyResume(bob);
      const bobTemplate = await readyTemplate(bob, "Bob's");
      await expect(createJob(bob, bobResume.fileId, bobTemplate.templateId)).resolves.toMatchObject(
        { status: "QUEUED" },
      );
    });

    it("stops AI planning at the overall deadline", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const job = await createJob(alice, resume.fileId, template.templateId);
      const hanging = createFakeAIProvider({
        formatResume: (_input, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      });
      const result = await service.runFormattingJob(alice, job.id, {
        ...deps(hanging),
        planningDeadlineMs: 50,
      });
      expect(result).toMatchObject({ status: "FAILED", canRetry: true });
      expect(result?.failureMessage).toContain("took too long");
    });

    it("removes the stored object when the post-upload check fails", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const job = await createJob(alice, resume.fileId, template.templateId);
      const realHead = storage.head.bind(storage);
      storage.head = async (key) => {
        const info = await realHead(key);
        return key.includes("/generated/") && info ? { ...info, sizeBytes: 1 } : info;
      };
      const result = await service.runFormattingJob(alice, job.id, deps());
      expect(result?.failureMessage).toContain("couldn't be saved");
      expect(storage.putKeys).toHaveLength(1);
      expect(storage.deletedKeys).toEqual(storage.putKeys);
      expect(storage.objects.has(storage.putKeys[0]!)).toBe(false);
    });
  });
  describe("resending an earlier message", () => {
    it("removes the resumes generated after it (files included), stops running ones and leaves everything else", async () => {
      const resume = await readyResume(alice);
      const { conversation } = await chat.createConversation(alice, {
        message: "Here is my resume",
        attachmentFileIds: [resume.fileId],
      });
      const other = await chat.createConversation(alice, { message: "another chat" });
      const t1 = await readyTemplate(alice, "Client A");
      const t2 = await readyTemplate(alice, "Client B");
      const t3 = await readyTemplate(alice, "Client C");
      const make = async (templateId: string, conversationId: string) =>
        (
          await service.createFormattingJob(
            alice,
            { resumeFileId: resume.fileId, templateId },
            deps(),
            { conversationId },
          )
        ).job;

      const before = await make(t1.templateId, conversation.id); // before the cut-off
      await service.runFormattingJob(alice, before.id, deps());
      const cutoff = new Date(Date.now() + 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const done = await make(t2.templateId, conversation.id);
      await service.runFormattingJob(alice, done.id, deps());
      const running = await make(t3.templateId, conversation.id); // still queued
      const elsewhere = await make(t1.templateId, other.conversation.id); // another chat

      const doneKey = (
        await db.generatedDocument.findFirstOrThrow({ where: { formattingJobId: done.id } })
      ).storageKey;
      const beforeKey = (
        await db.generatedDocument.findFirstOrThrow({ where: { formattingJobId: before.id } })
      ).storageKey;
      expect(storage.objects.has(doneKey)).toBe(true);

      const removed = await service.discardConversationJobsAfter(
        alice,
        conversation.id,
        cutoff,
        deps(),
      );
      expect(removed).toBe(2);

      const left = await db.formattingJob.findMany({
        where: { userId: alice },
        select: { id: true },
      });
      expect(left.map((job) => job.id).sort()).toEqual([before.id, elsewhere.id].sort());
      expect(storage.objects.has(doneKey)).toBe(false); // its Word file is gone
      expect(storage.objects.has(beforeKey)).toBe(true); // an earlier one is kept
      // The stopped job can no longer run or save anything.
      expect(await service.runFormattingJob(alice, running.id, deps())).toBeNull();
      // Another user cannot remove anyone's resumes.
      expect(
        await service.discardConversationJobsAfter(bob, conversation.id, new Date(0), deps()),
      ).toBe(0);
    });
  });

  describe("stopping a job", () => {
    it("stops a queued job: it ends as stopped, can be retried, and never runs", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const job = await createJob(alice, resume.fileId, template.templateId);

      const stopped = await service.cancelFormattingJob(alice, job.id);
      expect(stopped).toMatchObject({ status: "FAILED", canRetry: true });
      expect(stopped.failureMessage).toMatch(/Stopped/);
      // A stopped job is not picked up, and the same resume + template can start again.
      expect(await service.runFormattingJob(alice, job.id, deps())).toBeNull();
      expect(calls).toHaveLength(0);
      const { created } = await service.createFormattingJob(
        alice,
        { resumeFileId: resume.fileId, templateId: template.templateId },
        deps(),
      );
      expect(created).toBe(true);
    });

    it("a run stopped midway saves nothing", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const job = await createJob(alice, resume.fileId, template.templateId);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = createFakeAIProvider({
        modelName: "fake-mimo",
        analyzeTemplate: async () => structuredClone(SAMPLE_TEMPLATE_STRUCTURE) as never,
        formatResume: async () => {
          await gate;
          const { aiFormattingPlanSchema } = await import("@/lib/formatting/plan");
          return aiFormattingPlanSchema.parse(PLAN);
        },
      });

      const running = service.runFormattingJob(alice, job.id, deps(slow));
      await vi.waitFor(async () => {
        expect((await db.formattingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
          "PROCESSING",
        );
      });
      await service.cancelFormattingJob(alice, job.id);
      release();
      await running;

      const row = await db.formattingJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { document: true },
      });
      expect(row).toMatchObject({ status: "FAILED", failureCode: "cancelled", document: null });
      expect(storage.objects.size).toBe(2); // only the uploaded resume and template remain
    });

    it("leaves a finished job alone, and only the owner can stop a job", async () => {
      const resume = await readyResume(alice);
      const template = await readyTemplate(alice);
      const job = await createJob(alice, resume.fileId, template.templateId);
      await service.runFormattingJob(alice, job.id, deps());

      expect(await service.cancelFormattingJob(alice, job.id)).toMatchObject({
        status: "COMPLETED",
      });
      await expect(service.cancelFormattingJob(bob, job.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("formatting from the chat", () => {
    /** A chat whose first message carries the READY resume. */
    async function chatWithResume(userId: string, text = "Here is my resume") {
      const resume = await readyResume(userId);
      const { conversation } = await chat.createConversation(userId, {
        message: text,
        attachmentFileIds: [resume.fileId],
      });
      return { resume, conversationId: conversation.id };
    }

    it("formats the chat's resume with the template named in the message, and shows it in that chat", async () => {
      const { resume, conversationId } = await chatWithResume(alice);
      const template = await readyTemplate(alice, "Client A");

      const { job, created } = await service.startFormattingFromChat(
        alice,
        conversationId,
        { text: "Please format my resume using client a" },
        deps(),
      );
      expect(created).toBe(true);
      expect(job).toMatchObject({
        status: "QUEUED",
        conversationId,
        resume: { fileId: resume.fileId },
        template: { id: template.templateId },
      });

      expect(await service.runFormattingJob(alice, job.id, deps())).toMatchObject({
        status: "COMPLETED",
      });
      const inChat = await service.listConversationFormattingJobs(alice, conversationId);
      expect(inChat.map((item) => [item.id, item.status])).toEqual([[job.id, "COMPLETED"]]);
      expect(await service.listConversationFormattingJobs(bob, conversationId)).toEqual([]);
    });

    it("falls back to the template selected for the chat, and to the newest resume", async () => {
      const { conversationId } = await chatWithResume(alice);
      const newer = await readyResume(alice);
      await chat.sendUserMessage(alice, conversationId, {
        content: "updated CV",
        attachmentFileIds: [newer.fileId],
      });
      const template = await readyTemplate(alice, "Selected one");
      await templates.selectConversationTemplate(alice, conversationId, {
        templateId: template.templateId,
      });

      const { job } = await service.startFormattingFromChat(
        alice,
        conversationId,
        { text: "format it" },
        deps(),
      );
      expect(job).toMatchObject({
        resume: { fileId: newer.fileId },
        template: { id: template.templateId },
      });
    });

    it("starts one job per template named in a message (typos and short names included)", async () => {
      const { conversationId } = await chatWithResume(alice);
      const bayer = await readyTemplate(alice, "Bayer");
      const ceridian = await readyTemplate(alice, "Ceridian");
      const meridian = await readyTemplate(alice, "Meridian Health Systems");

      const started = await service.startFormattingsFromChat(
        alice,
        conversationId,
        { text: "format for ceredian and meridian also" },
        deps(),
      );
      expect(started.map((entry) => entry.job.template?.id)).toEqual([
        ceridian.templateId,
        meridian.templateId,
      ]);
      expect(started.some((entry) => entry.job.template?.id === bayer.templateId)).toBe(false);
    });

    it("never falls back to the template of the previous reply unless the message is a bare yes", async () => {
      const { conversationId } = await chatWithResume(alice);
      await readyTemplate(alice, "Bayer");
      const previousReply = "Formatting is underway using the Bayer template. Want another one?";

      // A message naming something that matches no template is not answered with Bayer.
      await expect(
        service.startFormattingFromChat(
          alice,
          conversationId,
          { text: "format for zillowish", previousReply },
          deps(),
        ),
      ).rejects.toMatchObject({
        publicMessage: expect.stringMatching(/couldn't tell which client template/),
      });

      // "yes" does answer the offer in that reply.
      const { job } = await service.startFormattingFromChat(
        alice,
        conversationId,
        { text: "yes", previousReply },
        deps(),
      );
      expect(job.template?.name).toBe("Bayer");
    });

    describe("changes asked for in chat (sections left out, bullets)", () => {
      it("applies a change to the newest formatted resume, builds on earlier changes and can undo them", async () => {
        const { conversationId } = await chatWithResume(alice);
        await readyTemplate(alice, "Client A");
        const first = await service.startFormattingsFromChat(
          alice,
          conversationId,
          { text: "format with client a", templateNames: ["Client A"] },
          deps(),
        );
        await service.runFormattingJob(alice, first[0]!.job.id, deps());
        expect(first[0]!.job.edits).toEqual([]);

        // "remove the skills section" names no template: it changes the newest resume.
        const second = await service.startFormattingsFromChat(
          alice,
          conversationId,
          { text: "remove the skills section", edits: [{ action: "remove", section: "skills" }] },
          deps(),
        );
        expect(second).toHaveLength(1);
        expect(second[0]!.job.template?.name).toBe("Client A");
        expect(second[0]!.job.edits).toEqual(["Without Skills"]);
        expect(second[0]!.job.id).not.toBe(first[0]!.job.id);
        await service.runFormattingJob(alice, second[0]!.job.id, deps());

        // A further change adds to it ...
        const third = await service.startFormattingsFromChat(
          alice,
          conversationId,
          {
            text: "education as bullets",
            edits: [{ action: "bullets", section: "Education" }],
          },
          deps(),
        );
        expect(third[0]!.job.edits).toEqual(["Without Skills", "Education as bullets"]);
        await service.runFormattingJob(alice, third[0]!.job.id, deps());

        // ... and can be undone.
        const fourth = await service.startFormattingsFromChat(
          alice,
          conversationId,
          { text: "bring skills back", edits: [{ action: "restore", section: "Skills" }] },
          deps(),
        );
        expect(fourth[0]!.job.edits).toEqual(["Education as bullets"]);
      });

      it("leaves the section out of the Word file", async () => {
        const { conversationId } = await chatWithResume(alice);
        await readyTemplate(alice, "Client A");
        const [started] = await service.startFormattingsFromChat(
          alice,
          conversationId,
          {
            text: "format with client a without skills",
            templateNames: ["Client A"],
            edits: [{ action: "remove", section: "Skills" }],
          },
          deps(),
        );
        const job = started!.job;
        const done = await service.runFormattingJob(alice, job.id, deps());
        expect(done).toMatchObject({ status: "COMPLETED", edits: ["Without Skills"] });
        // The AI was never shown the removed section.
        expect(JSON.stringify(calls.at(-1)!.resume)).not.toContain("Skills");
        const stored = await db.generatedDocument.findFirstOrThrow({
          where: { formattingJobId: job.id },
        });
        expect(storage.objects.has(stored.storageKey)).toBe(true);
      });

      it("explains what is missing: nothing formatted yet, or a section the resume doesn't have", async () => {
        const { conversationId } = await chatWithResume(alice);
        await readyTemplate(alice, "Client A");
        await expect(
          service.startFormattingsFromChat(
            alice,
            conversationId,
            { text: "remove skills", edits: [{ action: "remove", section: "Skills" }] },
            deps(),
          ),
        ).rejects.toMatchObject({
          publicMessage: expect.stringMatching(/no formatted resume in this chat yet/),
        });

        const [started] = await service.startFormattingsFromChat(
          alice,
          conversationId,
          { text: "format with client a", templateNames: ["Client A"] },
          deps(),
        );
        const job = started!.job;
        await service.runFormattingJob(alice, job.id, deps());
        await expect(
          service.startFormattingsFromChat(
            alice,
            conversationId,
            { text: "remove hobbies", edits: [{ action: "remove", section: "Hobbies" }] },
            deps(),
          ),
        ).rejects.toMatchObject({
          publicMessage: expect.stringMatching(/couldn't find a section called "Hobbies"/),
        });
      });

      it("does not start a change while the same resume is still being formatted", async () => {
        const { conversationId } = await chatWithResume(alice);
        await readyTemplate(alice, "Client A");
        await service.startFormattingsFromChat(
          alice,
          conversationId,
          { text: "format with client a", templateNames: ["Client A"] },
          deps(),
        ); // still queued
        await expect(
          service.startFormattingsFromChat(
            alice,
            conversationId,
            { text: "remove skills", edits: [{ action: "remove", section: "Skills" }] },
            deps(),
          ),
        ).rejects.toMatchObject({ status: 409 });
      });
    });

    it("explains what is missing: no resume in this chat, no template, AI not configured", async () => {
      const { conversation: empty } = await chat.createConversation(alice, { message: "hi" });
      await expect(
        service.startFormattingFromChat(alice, empty.id, { text: "format" }, deps()),
      ).rejects.toMatchObject({
        status: 400,
        publicMessage: expect.stringMatching(/Attach a PDF or DOCX resume in this chat/),
      });

      const { conversationId } = await chatWithResume(alice);
      await expect(
        service.startFormattingFromChat(alice, conversationId, { text: "format" }, deps()),
      ).rejects.toMatchObject({ publicMessage: expect.stringMatching(/Which client template/) });

      const noAI = {
        getStorage: () => storage,
        getProvider: (): AIProvider => {
          throw new Error("off");
        },
      };
      await expect(
        service.startFormattingFromChat(alice, conversationId, { text: "format" }, noAI),
      ).rejects.toMatchObject({
        status: 503,
        publicMessage: expect.stringMatching(/needs the AI service/),
      });
    });

    it("only uses resumes attached in this chat, and only the owner's chats", async () => {
      const { conversationId } = await chatWithResume(alice);
      const other = await chatWithResume(alice, "another chat");
      const template = await readyTemplate(alice, "Client A");
      await expect(
        service.startFormattingFromChat(
          alice,
          conversationId,
          { resumeFileId: other.resume.fileId, templateId: template.templateId },
          deps(),
        ),
      ).rejects.toMatchObject({
        publicMessage: expect.stringMatching(/isn't attached to this chat/),
      });
      await expect(
        service.startFormattingFromChat(
          bob,
          conversationId,
          { templateId: template.templateId },
          deps(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it(
      "waits for a resume that is still being read when formatting was requested",
      { timeout: 20_000 },
      async () => {
        const { resume, conversationId } = await chatWithResume(alice);
        const template = await readyTemplate(alice, "Client A");
        await db.resumeExtraction.update({
          where: { uploadedFileId: resume.fileId },
          data: { status: "PROCESSING" },
        });

        const { job } = await service.startFormattingFromChat(
          alice,
          conversationId,
          { templateId: template.templateId },
          deps(),
        );
        // Reading finishes a moment later (Prisma queries only run once awaited/then-ed).
        setTimeout(() => {
          db.resumeExtraction
            .update({ where: { uploadedFileId: resume.fileId }, data: { status: "READY" } })
            .then(
              () => {},
              () => {},
            );
        }, 1_000);
        expect(
          await service.runFormattingJob(alice, job.id, { ...deps(), resumeWaitMs: 10_000 }),
        ).toMatchObject({ status: "COMPLETED" });
      },
    );
  });
});
