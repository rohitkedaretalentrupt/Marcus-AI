import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FILE_BYTES } from "@test/fixtures/file-bytes";
import { InMemoryStorageProvider } from "@test/fakes/in-memory-storage-provider";

/**
 * Upload lifecycle and ownership against a REAL PostgreSQL database
 * (TEST_DATABASE_URL). Object storage is the in-memory test double; live
 * Cloudflare R2 is NOT exercised here.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@files.integration.example.test";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.skipIf(!TEST_DATABASE_URL)("file service (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { NotFoundError, RateLimitError, ServiceUnavailableError, ValidationError } =
    await import("@/lib/errors/app-error");
  const { FILE_LIMITS } = await import("@/lib/files/limits");
  const service = await import("./file-service");

  const db = getDb();
  let storage: InMemoryStorageProvider;
  let deps: { getStorage: () => InMemoryStorageProvider };
  let alice: string;
  let bob: string;

  const cleanup = () => db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  beforeAll(async () => {
    await cleanup();
    alice = (await db.user.create({ data: { email: `alice${EMAIL_DOMAIN}` } })).id;
    bob = (await db.user.create({ data: { email: `bob${EMAIL_DOMAIN}` } })).id;
  });
  beforeEach(async () => {
    await db.uploadedFile.deleteMany({ where: { userId: { in: [alice, bob] } } });
    storage = new InMemoryStorageProvider();
    deps = { getStorage: () => storage };
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  async function uploaded(
    userId: string,
    {
      filename = "resume.pdf",
      contentType = "application/pdf",
      bytes = FILE_BYTES.pdf as Uint8Array,
    } = {},
  ) {
    const auth = await service.requestUpload(
      userId,
      { filename, contentType, sizeBytes: bytes.length },
      deps,
    );
    const { storageKey } = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
    storage.simulateBrowserUpload(storageKey, bytes, contentType);
    return { auth, storageKey };
  }

  describe("requestUpload", () => {
    it("creates a PENDING_UPLOAD record with a server-generated key and a presigned PUT", async () => {
      const auth = await service.requestUpload(
        alice,
        { filename: "../../My Resume.pdf", contentType: "application/pdf", sizeBytes: 2048 },
        deps,
      );
      const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });

      expect(row).toMatchObject({ userId: alice, status: "PENDING_UPLOAD", sizeBytes: 2048 });
      expect(row.originalFilename).toBe("My Resume.pdf");
      expect(row.id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.storageKey).toBe(`users/${alice}/uploads/${row.id}.pdf`);
      expect(row.storageKey).not.toContain("Resume");
      expect(storage.issuedUploads).toEqual([
        {
          key: row.storageKey,
          contentType: "application/pdf",
          contentLength: 2048,
          expiresInSeconds: FILE_LIMITS.uploadUrlTtlSeconds,
        },
      ]);
      expect(auth.upload.method).toBe("PUT");
      expect(auth.file).not.toHaveProperty("storageKey");
    });

    it("uses the canonical extension for the verified type, not the user's", async () => {
      const auth = await service.requestUpload(
        alice,
        { filename: "photo.JPEG", contentType: "image/jpeg", sizeBytes: 10 },
        deps,
      );
      const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
      expect(row.storageKey.endsWith(`${row.id}.jpg`)).toBe(true);
    });

    it("rejects invalid metadata without creating records", async () => {
      for (const input of [
        { filename: "a.exe", contentType: "application/x-msdownload", sizeBytes: 10 },
        {
          filename: "a.pdf",
          contentType: "application/pdf",
          sizeBytes: FILE_LIMITS.maxFileBytes + 1,
        },
        { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, storageKey: "x" },
      ]) {
        await expect(service.requestUpload(alice, input, deps)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      expect(await db.uploadedFile.count({ where: { userId: alice } })).toBe(0);
    });

    it("limits how many uploads a user can have in progress", async () => {
      const input = { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 };
      for (let i = 0; i < FILE_LIMITS.maxPendingUploadsPerUser; i++) {
        await service.requestUpload(alice, input, deps);
      }
      await expect(service.requestUpload(alice, input, deps)).rejects.toBeInstanceOf(
        RateLimitError,
      );
      await expect(service.requestUpload(bob, input, deps)).resolves.toBeDefined();
    });

    it("fails cleanly (no record) when storage is not configured", async () => {
      const unavailable = {
        getStorage: () => {
          throw new ServiceUnavailableError("File uploads aren't available right now.");
        },
      };
      await expect(
        service.requestUpload(
          alice,
          { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1 },
          unavailable,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(await db.uploadedFile.count({ where: { userId: alice } })).toBe(0);
    });
  });

  describe("confirmUpload", () => {
    it.each([
      ["resume.pdf", "application/pdf", FILE_BYTES.pdf],
      ["resume.docx", DOCX, FILE_BYTES.docx],
      ["photo.jpg", "image/jpeg", FILE_BYTES.jpeg],
      ["scan.png", "image/png", FILE_BYTES.png],
      ["scan.webp", "image/webp", FILE_BYTES.webp],
    ])("verifies a real %s and marks it UPLOADED", async (filename, contentType, bytes) => {
      const { auth } = await uploaded(alice, { filename, contentType, bytes });
      const file = await service.confirmUpload(alice, auth.file.id, deps);
      expect(file).toMatchObject({ id: auth.file.id, status: "UPLOADED", filename });
      // idempotent
      await expect(service.confirmUpload(alice, auth.file.id, deps)).resolves.toMatchObject({
        status: "UPLOADED",
      });
    });

    it("fails when the browser never uploaded the object", async () => {
      const auth = await service.requestUpload(
        alice,
        { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 },
        deps,
      );
      await expect(service.confirmUpload(alice, auth.file.id, deps)).rejects.toBeInstanceOf(
        service.UploadVerificationError,
      );
      expect(
        (await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } })).status,
      ).toBe("FAILED");
    });

    it.each([
      [
        "HTML disguised as a PDF (signature)",
        FILE_BYTES.html,
        "application/pdf",
        "signature_mismatch",
      ],
      ["a different stored content type", FILE_BYTES.pdf, "text/html", "type_mismatch"],
    ])("rejects %s, deletes the object and marks FAILED", async (_n, bytes, storedType, reason) => {
      const auth = await service.requestUpload(
        alice,
        { filename: "resume.pdf", contentType: "application/pdf", sizeBytes: bytes.length },
        deps,
      );
      const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
      storage.simulateBrowserUpload(row.storageKey, bytes, storedType);

      await expect(service.confirmUpload(alice, auth.file.id, deps)).rejects.toBeInstanceOf(
        service.UploadVerificationError,
      );
      const after = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
      expect(after).toMatchObject({ status: "FAILED", failureReason: reason });
      expect(storage.objects.has(row.storageKey)).toBe(false);
    });

    it("rejects an object whose size differs from the declared size", async () => {
      const auth = await service.requestUpload(
        alice,
        { filename: "resume.pdf", contentType: "application/pdf", sizeBytes: 5 },
        deps,
      );
      const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
      storage.simulateBrowserUpload(row.storageKey, FILE_BYTES.pdf, "application/pdf");
      await expect(service.confirmUpload(alice, auth.file.id, deps)).rejects.toBeInstanceOf(
        service.UploadVerificationError,
      );
    });

    it("a FAILED upload can never be confirmed afterwards", async () => {
      const auth = await service.requestUpload(
        alice,
        { filename: "a.pdf", contentType: "application/pdf", sizeBytes: FILE_BYTES.pdf.length },
        deps,
      );
      await expect(service.confirmUpload(alice, auth.file.id, deps)).rejects.toThrow();
      const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: auth.file.id } });
      storage.simulateBrowserUpload(row.storageKey, FILE_BYTES.pdf, "application/pdf");
      await expect(service.confirmUpload(alice, auth.file.id, deps)).rejects.toBeInstanceOf(
        service.UploadVerificationError,
      );
    });
  });

  describe("ownership", () => {
    it("another user cannot confirm, download or discard the file", async () => {
      const { auth } = await uploaded(alice);

      await expect(service.confirmUpload(bob, auth.file.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await service.confirmUpload(alice, auth.file.id, deps);
      await expect(service.createDownloadUrl(bob, auth.file.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.discardUpload(bob, auth.file.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await db.uploadedFile.count({ where: { id: auth.file.id } })).toBe(1);
    });

    it("rejects malformed ids (no key or path can be passed)", async () => {
      for (const id of ["../../x", "users/abc/uploads/x.pdf", ""]) {
        await expect(service.createDownloadUrl(alice, id, deps)).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
    });
  });

  describe("download + discard", () => {
    it("issues download URLs only for verified files", async () => {
      const { auth } = await uploaded(alice);
      await expect(service.createDownloadUrl(alice, auth.file.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      await service.confirmUpload(alice, auth.file.id, deps);
      const download = await service.createDownloadUrl(alice, auth.file.id, deps);
      expect(download.url).toContain("download=1");
    });

    it("discarding an unsent file deletes the object and the record", async () => {
      const { auth, storageKey } = await uploaded(alice);
      await service.confirmUpload(alice, auth.file.id, deps);

      await service.discardUpload(alice, auth.file.id, deps);
      expect(storage.objects.has(storageKey)).toBe(false);
      expect(await db.uploadedFile.count({ where: { id: auth.file.id } })).toBe(0);
    });
  });
});
