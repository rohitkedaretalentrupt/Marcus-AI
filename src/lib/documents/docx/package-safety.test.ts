import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { makeDocx, SAMPLE_RESUME_LINES } from "@test/fixtures/make-documents";

import { assertSafeDocxPackage, DOCX_PACKAGE_LIMITS, UnsafePackageError } from "./package-safety";

describe("assertSafeDocxPackage", () => {
  it("accepts a normal DOCX", async () => {
    await expect(
      assertSafeDocxPackage(await makeDocx(SAMPLE_RESUME_LINES)),
    ).resolves.toBeUndefined();
  });

  it("rejects a zip bomb (tiny upload, huge decompressed part) without inflating it fully", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    // ~40 MB of zeros compresses to ~40 KB.
    zip.file(
      "word/document.xml",
      new Uint8Array(DOCX_PACKAGE_LIMITS.maxEntryBytes + 10 * 1024 * 1024),
    );
    const bomb = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bomb.length).toBeLessThan(200_000);

    await expect(assertSafeDocxPackage(bomb)).rejects.toBeInstanceOf(UnsafePackageError);
  });

  // Builds ~62 MB of (highly compressible) data, so allow time on a busy machine.
  it(
    "rejects many medium parts that add up past the total limit",
    { timeout: 30_000 },
    async () => {
      const zip = new JSZip();
      const part = new Uint8Array(DOCX_PACKAGE_LIMITS.maxTotalBytes / 4 + 512 * 1024);
      for (let i = 0; i < 4; i++) zip.file(`word/media/part${i}.bin`, part);
      const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      await expect(assertSafeDocxPackage(data)).rejects.toThrow(/too large/);
    },
  );

  it("rejects packages with too many entries, and non-ZIP data", async () => {
    const zip = new JSZip();
    for (let i = 0; i <= DOCX_PACKAGE_LIMITS.maxEntries; i++) zip.file(`x/${i}.xml`, "<a/>");
    const many = await zip.generateAsync({ type: "uint8array" });
    await expect(assertSafeDocxPackage(many)).rejects.toThrow(/too many entries/);
    await expect(assertSafeDocxPackage(new TextEncoder().encode("not a zip"))).rejects.toThrow(
      /not a readable ZIP/,
    );
  });
});
