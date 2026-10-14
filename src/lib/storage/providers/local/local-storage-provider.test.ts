import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StorageKey } from "../../types";

import { createLocalStorageProvider, isValidLocalKey } from "./local-storage-provider";

const KEY = "users/user1/uploads/abc123.pdf" as StorageKey;

describe("local storage provider (development only)", () => {
  let root: string;
  let storage: ReturnType<typeof createLocalStorageProvider>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "local-storage-test-"));
    storage = createLocalStorageProvider({ rootDir: root, signingKey: "test-only-signing-key" });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("stores, inspects, reads and deletes objects inside its folder", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 synthetic");
    await storage.putObject(KEY, bytes, "application/pdf");

    expect(await storage.head(KEY)).toEqual({
      sizeBytes: bytes.length,
      contentType: "application/pdf",
    });
    expect(new TextDecoder().decode(await storage.readPrefix(KEY, 4))).toBe("%PDF");
    expect(await storage.getObject(KEY, 1024)).toEqual(bytes);
    await expect(storage.getObject(KEY, 3)).rejects.toThrow(/size limit/);
    expect(await readdir(path.join(root, "users", "user1", "uploads"))).toEqual(
      expect.arrayContaining(["abc123.pdf", "abc123.pdf.meta.json"]),
    );

    await storage.delete(KEY);
    await storage.delete(KEY); // idempotent
    expect(await storage.head(KEY)).toBeNull();
  });

  it("issues signed, expiring links that fix the operation, key, type and size", async () => {
    const upload = await storage.createUploadUrl({
      key: KEY,
      contentType: "application/pdf",
      contentLength: 18,
      expiresInSeconds: 600,
    });
    expect(upload.url).toMatch(/^\/api\/storage\/local\?token=/);
    expect(upload.headers).toEqual({ "Content-Type": "application/pdf" });
    const token = new URL(upload.url, "http://x").searchParams.get("token")!;
    expect(storage.verifyToken(token)).toMatchObject({ op: "put", key: KEY, length: 18 });

    // Tampering with the payload or signature, or using another key, invalidates it.
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), length: 999 }),
    ).toString("base64url");
    expect(storage.verifyToken(`${forged}.${mac}`)).toBeNull();
    expect(storage.verifyToken(`${body}.AAAA`)).toBeNull();
    const other = createLocalStorageProvider({ rootDir: root, signingKey: "different-key" });
    expect(other.verifyToken(token)).toBeNull();

    const expired = await storage.createDownloadUrl(KEY, {
      expiresInSeconds: -1,
      downloadFilename: "cv.pdf",
      contentType: "application/pdf",
    });
    expect(
      storage.verifyToken(new URL(expired.url, "http://x").searchParams.get("token")!),
    ).toBeNull();
  });

  it.each([
    "../outside.pdf",
    "users/user1/uploads/../../../etc/passwd",
    "users/user1/other/abc.pdf",
    "users/user1/uploads/abc.pdf/../../x.pdf",
    "C:\\Windows\\win.ini",
  ])("rejects a key outside the server-generated layout: %s", async (key) => {
    expect(isValidLocalKey(key)).toBe(false);
    await expect(storage.putObject(key as StorageKey, new Uint8Array([1]), "x/y")).rejects.toThrow(
      /Invalid storage key/,
    );
  });
});
