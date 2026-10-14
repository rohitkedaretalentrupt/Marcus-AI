import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { makeDocx, makeTemplatePdf } from "@test/fixtures/make-documents";

/**
 * REAL end-to-end workflow (run with `npm run test:live`, never in CI):
 *
 *   synthetic resume → presigned PUT to R2 → confirm → extraction
 *   → synthetic template → R2 → MiMo template analysis
 *   → MiMo formatting plan → DOCX → R2 → signed download → validation
 *
 * Uses the TEST database and real MiMo + R2 from .env. Only synthetic,
 * fictional data is used. Every object and row it creates is deleted at the
 * end. Logs contain statuses and timings only — never keys, URLs or content.
 */

const configured =
  process.env.LIVE_E2E === "1" &&
  Boolean(process.env.TEST_DATABASE_URL) &&
  Boolean(process.env.AI_PROVIDER && process.env.AI_API_KEY) &&
  process.env.STORAGE_PROVIDER === "r2";

const RESUME_LINES = [
  "Jordan Synthetic",
  "Supply Chain Analyst",
  "jordan.synthetic@example.test | 555-010-2468 | Portland, OR",
  "https://www.linkedin.com/in/jordan-synthetic-example",
  "",
  "Summary",
  "Analyst with six years of synthetic experience in logistics reporting.",
  "",
  "Experience",
  "Senior Supply Chain Analyst",
  "Northwind Synthetic Traders",
  "Mar 2021 - Present",
  "• Cut synthetic stock-outs by 18% with a weekly demand model",
  "• Built 12 dashboards for regional managers",
  "Supply Chain Analyst",
  "Fabrikam Example Logistics",
  "Jun 2018 - Feb 2021",
  "• Automated carrier invoice checks",
  "",
  "Education",
  "Example State University",
  "B.S. Industrial Engineering, 2018",
  "",
  "Skills",
  "SQL, Python, Excel, Power BI, SAP",
  "",
  "Certifications",
  "Certified Example Planner, 2022",
];

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EMAIL = `live-e2e-${Date.now()}@live.integration.example.test`;
const step = (name: string, started: number) =>
  console.info(`[live-e2e] ${name} (${Math.round((Date.now() - started) / 100) / 10}s)`);

describe.skipIf(!configured)("REAL workflow: R2 + extraction + MiMo + DOCX", async () => {
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL ?? "");
  vi.stubEnv("NODE_ENV", "test");

  const { getDb } = await import("@/lib/db/client");
  const { getStorageProvider } = await import("@/lib/storage/provider");
  const { validateDocx } = await import("@/lib/documents/docx/docx-validation");
  const { getResumeExtraction, runResumeExtraction, startResumeExtraction } =
    await import("@/server/resumes/extraction-service");
  const files = await import("@/server/files/file-service");
  const templates = await import("@/server/templates/template-service");
  const formatting = await import("./formatting-service");

  const db = getDb();
  // Resolved lazily: the describe body is collected even when the suite is skipped.
  const storage = {
    delete: (key: never) => getStorageProvider().delete(key),
    head: (key: never) => getStorageProvider().head(key),
  };
  const createdKeys: string[] = [];
  let userId = "";

  /** Uploads like the browser does: presigned PUT straight to R2, then server-side confirm. */
  async function upload(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    purpose?: "template",
  ) {
    const { file, upload: put } = await files.requestUpload(userId, {
      filename,
      contentType,
      sizeBytes: bytes.length,
      ...(purpose ? { purpose } : {}),
    });
    const response = await fetch(put.url, {
      method: put.method,
      headers: put.headers,
      body: new Blob([new Uint8Array(bytes)]),
    });
    expect(response.status, "R2 presigned PUT").toBe(200);
    const confirmed = await files.confirmUpload(userId, file.id);
    expect(confirmed.status).toBe("UPLOADED");
    const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: file.id } });
    createdKeys.push(row.storageKey);
    return file.id;
  }

  afterAll(async () => {
    // Remove everything this test created, objects first.
    for (const key of createdKeys) await storage.delete(key as never).catch(() => {});
    for (const key of createdKeys) {
      expect(await storage.head(key as never), "object removed from R2").toBeNull();
    }
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.$disconnect();
  });

  it("formats a synthetic resume end to end with the configured services", async () => {
    const t0 = Date.now();
    userId = (await db.user.create({ data: { email: EMAIL, name: "Live E2E" } })).id;

    // 1. Resume → R2 → extraction
    const resumeFileId = await upload(await makeDocx(RESUME_LINES), "synthetic-resume.docx", DOCX);
    await startResumeExtraction(userId, resumeFileId);
    await runResumeExtraction(userId, resumeFileId);
    const extraction = await getResumeExtraction(userId, resumeFileId);
    expect(extraction?.status).toBe("READY");
    step("resume uploaded to R2 and extracted", t0);

    // 2. Template → R2 → MiMo analysis
    const templateFileId = await upload(
      await makeTemplatePdf(),
      "synthetic-template.pdf",
      "application/pdf",
      "template",
    );
    const template = await templates.createTemplate(userId, {
      name: "Live E2E Template",
      fileId: templateFileId,
    });
    const analysed = await templates.runTemplateAnalysis(userId, template.id);
    expect(analysed?.status, analysed?.failureMessage ?? "").toBe("READY");
    expect(analysed?.structure?.sections.length).toBeGreaterThan(0);
    step(`template analysed by ${analysed?.analyzedBy}`, t0);

    // 3. MiMo plan → DOCX → R2
    const { job } = await formatting.createFormattingJob(userId, {
      resumeFileId,
      templateId: template.id,
    });
    const done = await formatting.runFormattingJob(userId, job.id);
    expect(done?.status, done?.failureMessage ?? "").toBe("COMPLETED");
    const generated = await db.generatedDocument.findFirstOrThrow({
      where: { formattingJobId: job.id },
    });
    createdKeys.push(generated.storageKey);
    step(`formatted (warnings: ${done?.warnings.length ?? 0})`, t0);

    // 4. Signed download (as the browser would follow it) → independent validation
    const download = await formatting.createFormattedDownloadUrl(userId, job.id);
    const response = await fetch(download.url);
    expect(response.status, "signed download").toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(generated.sizeBytes);
    expect(await validateDocx(bytes, extraction!.content!)).toEqual({ ok: true, problems: [] });

    // A tampered signature is refused by R2 (URLs cannot be reused for other objects).
    const tampered = download.url.replace(/X-Amz-Signature=[0-9a-f]{6}/, "X-Amz-Signature=000000");
    expect((await fetch(tampered)).status).toBe(403);

    // Keep a copy for manual review in Word (git-ignored folder).
    const outDir = path.join(process.cwd(), "tmp", "live-e2e");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, download.filename), bytes);
    step(`downloaded and validated → tmp/live-e2e/${download.filename}`, t0);

    // 5. Cleanup through the product's own delete flows.
    await formatting.deleteFormattingJob(userId, job.id);
    await templates.deleteTemplate(userId, template.id);
    await files.discardUpload(userId, resumeFileId);
    expect(await storage.head(generated.storageKey as never)).toBeNull();
    step("deleted through product flows", t0);
  });
});
