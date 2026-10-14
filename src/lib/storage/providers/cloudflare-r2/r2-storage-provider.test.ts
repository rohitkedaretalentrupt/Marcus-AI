import { describe, expect, it } from "vitest";

import { buildStorageKey } from "../../keys";

import { createR2StorageProvider } from "./r2-storage-provider";

/**
 * Offline checks of the R2 provider: presigning is pure computation (SigV4),
 * so the generated URLs can be inspected without network or real credentials.
 * This does NOT verify that a live R2 bucket accepts them.
 */
const SECRET = "test-only-secret-access-key";
const provider = createR2StorageProvider({
  endpoint: "https://testaccount.r2.cloudflarestorage.com",
  bucket: "resume-files",
  accessKeyId: "test-only-access-key-id",
  secretAccessKey: SECRET,
});
const key = buildStorageKey({
  userId: "user123",
  category: "uploads",
  objectId: "0123456789abcdef0123456789abcdef",
  extension: "pdf",
});

describe("R2 storage provider (offline presigning)", () => {
  it("presigns a PUT scoped to one key, content type and exact length", async () => {
    const upload = await provider.createUploadUrl({
      key,
      contentType: "application/pdf",
      contentLength: 12_345,
      expiresInSeconds: 600,
    });
    const url = new URL(upload.url);

    expect(upload.method).toBe("PUT");
    expect(upload.headers).toEqual({ "Content-Type": "application/pdf" });
    expect(url.host).toBe("testaccount.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/resume-files/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";").sort()).toEqual([
      "content-length",
      "content-type",
      "host",
    ]);
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
  });

  it("never puts the secret key in a URL and adds no checksum the browser would have to send", async () => {
    const upload = await provider.createUploadUrl({
      key,
      contentType: "image/png",
      contentLength: 10,
      expiresInSeconds: 60,
    });
    expect(upload.url).not.toContain(SECRET);
    expect(upload.url.toLowerCase()).not.toContain("x-amz-checksum");
    expect(upload.url.toLowerCase()).not.toContain("x-amz-sdk-checksum");
  });

  it("presigns a short-lived GET that forces download with a safe filename", async () => {
    const { url } = await provider.createDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'my "résumé".pdf',
      contentType: "application/pdf",
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("response-content-type")).toBe("application/pdf");
    const disposition = parsed.searchParams.get("response-content-disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).toContain('filename="my _r_sum__.pdf"');
    expect(disposition).toContain("filename*=UTF-8''my%20%22r%C3%A9sum%C3%A9%22.pdf");
  });
});
