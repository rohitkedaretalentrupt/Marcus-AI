import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-level tests for the file API. Only the Auth.js cookie lookup is
 * replaced. No storage is configured in tests, which also verifies the
 * "uploads unavailable" path; storage-dependent flows are covered by the
 * file-service tests.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth/config", () => ({ getAuthOptions: () => ({}) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");
  vi.stubEnv("STORAGE_PROVIDER", "");
}

const collection = await import("./route");
const item = await import("./[fileId]/route");
const confirm = await import("./[fileId]/confirm/route");
const download = await import("./[fileId]/download-url/route");
const extraction = await import("./[fileId]/extraction/route");
const mockedSession = vi.mocked(getServerSession);

function signInAs(userId: string | null) {
  mockedSession.mockResolvedValue(
    userId ? { user: { id: userId }, expires: new Date(Date.now() + 60_000).toISOString() } : null,
  );
}

const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/files", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (fileId: string) => ({ params: Promise.resolve({ fileId }) });
const VALID = { filename: "resume.pdf", contentType: "application/pdf", sizeBytes: 1000 };

describe("file API without a session", () => {
  beforeEach(() => {
    signInAs(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    [
      "POST /api/files",
      () => collection.POST(json("POST", VALID), { params: Promise.resolve({}) }),
    ],
    ["POST /api/files/:id/confirm", () => confirm.POST(json("POST"), ctx("abc"))],
    ["DELETE /api/files/:id", () => item.DELETE(json("DELETE"), ctx("abc"))],
    ["GET /api/files/:id/download-url", () => download.GET(json("GET"), ctx("abc"))],
    ["GET /api/files/:id/extraction", () => extraction.GET(json("GET"), ctx("abc"))],
    ["POST /api/files/:id/extraction", () => extraction.POST(json("POST"), ctx("abc"))],
  ])("%s → 401", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("file API with sessions (PostgreSQL)", async () => {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  const EMAIL_DOMAIN = "@files-api.integration.example.test";
  let alice: string;
  let bob: string;
  let alicesFile: string;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
    alicesFile = "a11ce0000000000000000000000000f1";
    await db.uploadedFile.create({
      data: {
        id: alicesFile,
        userId: alice,
        originalFilename: "resume.pdf",
        storageKey: `users/${alice}/uploads/${alicesFile}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 1000,
        status: "UPLOADED",
      },
    });
  });
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("validates metadata before anything else (400)", async () => {
    signInAs(alice);
    const response = await collection.POST(
      json("POST", { filename: "evil.svg", contentType: "image/svg+xml", sizeBytes: 10 }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(400);
  });

  it("reports uploads as unavailable when storage is not configured (503, no details)", async () => {
    signInAs(alice);
    const response = await collection.POST(json("POST", VALID), { params: Promise.resolve({}) });
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).toContain("File uploads aren't available right now.");
    expect(text).not.toMatch(/R2_|STORAGE_PROVIDER|cloudflare/i);
  });

  it("returns 404 for another user's file on every endpoint", async () => {
    signInAs(bob);
    for (const response of [
      await confirm.POST(json("POST"), ctx(alicesFile)),
      await item.DELETE(json("DELETE"), ctx(alicesFile)),
      await download.GET(json("GET"), ctx(alicesFile)),
      await extraction.GET(json("GET"), ctx(alicesFile)),
      await extraction.POST(json("POST"), ctx(alicesFile)),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(alice);
    }
    expect(await db.uploadedFile.count({ where: { id: alicesFile } })).toBe(1);
  });
});
