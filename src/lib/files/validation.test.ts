import { describe, expect, it } from "vitest";

import { FILE_LIMITS } from "./limits";
import { attachmentFileIdsSchema, uploadRequestSchema } from "./validation";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function parse(input: unknown) {
  return uploadRequestSchema.safeParse(input);
}

describe("uploadRequestSchema", () => {
  it.each([
    ["resume.pdf", "application/pdf"],
    ["Resume Final.DOCX", DOCX],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["scan.png", "image/png"],
    ["scan.webp", "image/webp"],
  ])("accepts %s as %s", (filename, contentType) => {
    const result = parse({ filename, contentType, sizeBytes: 1024 });
    expect(result.success).toBe(true);
  });

  it.each([
    ["virus.exe", "application/x-msdownload"],
    ["page.html", "text/html"],
    ["logo.svg", "image/svg+xml"],
    ["bundle.zip", "application/zip"],
    ["legacy.doc", "application/msword"],
  ])("rejects unsupported %s", (filename, contentType) => {
    expect(parse({ filename, contentType, sizeBytes: 1024 }).success).toBe(false);
  });

  it("rejects a supported MIME type that disagrees with the extension", () => {
    expect(parse({ filename: "resume.pdf", contentType: "image/png", sizeBytes: 10 }).success).toBe(
      false,
    );
    expect(
      parse({ filename: "resume.pdf.exe", contentType: "application/pdf", sizeBytes: 10 }).success,
    ).toBe(false);
    expect(
      parse({ filename: "resume", contentType: "application/pdf", sizeBytes: 10 }).success,
    ).toBe(false);
  });

  it("enforces the size limits", () => {
    const base = { filename: "a.pdf", contentType: "application/pdf" };
    expect(parse({ ...base, sizeBytes: FILE_LIMITS.maxFileBytes }).success).toBe(true);
    expect(parse({ ...base, sizeBytes: FILE_LIMITS.maxFileBytes + 1 }).success).toBe(false);
    expect(parse({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(parse({ ...base, sizeBytes: 1.5 }).success).toBe(false);
  });

  it("rejects invalid or extra metadata (no client-chosen keys, buckets or owners)", () => {
    expect(parse({ filename: "a.pdf", contentType: "application/pdf" }).success).toBe(false);
    expect(parse({ filename: "", contentType: "application/pdf", sizeBytes: 1 }).success).toBe(
      false,
    );
    for (const extra of [{ storageKey: "users/x/y.pdf" }, { bucket: "other" }, { userId: "u" }]) {
      expect(
        parse({ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("sanitises path components out of the display name", () => {
    const result = parse({
      filename: "../../etc/evil<script>.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
    });
    expect(result.success && result.data.filename).toBe("evil_script_.pdf");
    expect(result.success && result.data.extension).toBe("pdf");
  });
});

describe("attachmentFileIdsSchema", () => {
  it("limits the number of attachments and forbids duplicates", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `file${i}`);
    expect(
      attachmentFileIdsSchema.safeParse(ids(FILE_LIMITS.maxAttachmentsPerMessage)).success,
    ).toBe(true);
    expect(
      attachmentFileIdsSchema.safeParse(ids(FILE_LIMITS.maxAttachmentsPerMessage + 1)).success,
    ).toBe(false);
    expect(attachmentFileIdsSchema.safeParse(["a1", "a1"]).success).toBe(false);
    expect(attachmentFileIdsSchema.safeParse(["../x"]).success).toBe(false);
  });
});
