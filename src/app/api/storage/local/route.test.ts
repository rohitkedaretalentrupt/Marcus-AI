import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocalStorageProvider,
  type LocalStorageProvider,
} from "@/lib/storage/providers/local/local-storage-provider";
import type { StorageKey } from "@/lib/storage/types";

let storage: LocalStorageProvider | null = null;
vi.mock("@/lib/storage/provider", () => ({ getLocalStorageProvider: () => storage }));

const { GET, PUT } = await import("./route");

const KEY = "users/user1/uploads/abc123.pdf" as StorageKey;
const BYTES = new TextEncoder().encode("%PDF-1.7 synthetic test file");
const ctx = { params: Promise.resolve({}) };

const request = (method: string, url: string, body?: Uint8Array, contentType = "application/pdf") =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: body ? { "content-type": contentType } : {},
    body: body ? new Blob([new Uint8Array(body)]) : undefined,
  });

describe("local storage route", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "local-storage-route-"));
    storage = createLocalStorageProvider({ rootDir: root, signingKey: "test-only-signing-key" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    storage = null;
    await rm(root, { recursive: true, force: true });
  });

  const uploadUrl = (length = BYTES.length) =>
    storage!
      .createUploadUrl({
        key: KEY,
        contentType: "application/pdf",
        contentLength: length,
        expiresInSeconds: 600,
      })
      .then((upload) => upload.url);

  it("accepts an upload that matches its signed link, then serves a signed download", async () => {
    expect((await PUT(request("PUT", await uploadUrl(), BYTES), ctx)).status).toBe(200);
    expect(await storage!.head(KEY)).toEqual({
      sizeBytes: BYTES.length,
      contentType: "application/pdf",
    });

    const { url } = await storage!.createDownloadUrl(KEY, {
      expiresInSeconds: 300,
      downloadFilename: "Sam Rivera – CV.pdf",
      contentType: "application/pdf",
    });
    const response = await GET(request("GET", url), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Sam Rivera _ CV.pdf"/,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("rejects wrong size, wrong type, bad tokens and the wrong operation", async () => {
    const url = await uploadUrl();
    expect((await PUT(request("PUT", url, BYTES.slice(0, 5)), ctx)).status).toBe(400);
    expect((await PUT(request("PUT", url, new Uint8Array([...BYTES, 1])), ctx)).status).toBe(413);
    expect((await PUT(request("PUT", url, BYTES, "text/html"), ctx)).status).toBe(403);
    expect((await PUT(request("PUT", "/api/storage/local?token=nope", BYTES), ctx)).status).toBe(
      403,
    );
    // An upload link cannot be used to download.
    expect((await GET(request("GET", url), ctx)).status).toBe(403);
    expect(await storage!.head(KEY)).toBeNull();
  });

  it("is not available when another storage provider is configured", async () => {
    const url = await uploadUrl();
    storage = null;
    expect((await PUT(request("PUT", url, BYTES), ctx)).status).toBe(404);
  });
});
