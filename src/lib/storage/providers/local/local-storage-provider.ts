import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, open } from "node:fs/promises";
import path from "node:path";

import type { StorageKey, StorageProvider } from "../../types";

/*
 * DEVELOPMENT-ONLY storage in a folder on this computer (STORAGE_PROVIDER=local).
 * Refused in production by env validation. It mirrors how R2 is used, so the
 * rest of the app is unchanged:
 *
 * - The browser uploads with a short-lived signed PUT URL for one key, exact
 *   content type and exact size (`/api/storage/local?token=…`).
 * - Downloads use a short-lived signed GET URL (Content-Disposition: attachment).
 * - Keys must be server-generated (`users/{id}/{category}/{id}.{ext}`); any
 *   other path is rejected, so nothing outside the folder can be touched.
 *
 * Each object is stored as `<key>` with a `<key>.meta.json` sidecar holding
 * its content type.
 */

export interface LocalStorageConfig {
  /** Folder for stored files; relative paths are resolved from the app's working directory. */
  rootDir: string;
  /** HMAC key for upload/download links. */
  signingKey: string;
}

export const LOCAL_STORAGE_ROUTE = "/api/storage/local";

const KEY_PATTERN =
  /^users\/[A-Za-z0-9_-]{1,64}\/(?:uploads|templates|generated)\/[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,10}$/;

export type LocalTokenPayload =
  | { op: "put"; key: string; contentType: string; length: number; exp: number }
  | { op: "get"; key: string; contentType: string; filename: string; exp: number };

export interface LocalStorageProvider extends StorageProvider {
  readonly id: "local";
  /** Verifies a link token (signature + expiry); null when invalid. */
  verifyToken(token: string): LocalTokenPayload | null;
  /** Writes an uploaded body (already size-checked by the route). */
  writeUpload(key: StorageKey, data: Uint8Array, contentType: string): Promise<void>;
  /** Reads a stored object for a signed download. */
  readForDownload(key: StorageKey): Promise<Uint8Array | null>;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function isValidLocalKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes("..");
}

export function createLocalStorageProvider(config: LocalStorageConfig): LocalStorageProvider {
  const root = path.resolve(config.rootDir);

  const sign = (payload: LocalTokenPayload) => {
    const body = b64url(JSON.stringify(payload));
    const mac = createHmac("sha256", config.signingKey).update(body).digest();
    return `${body}.${b64url(mac)}`;
  };

  /** Absolute path for a key, guaranteed to be inside the storage folder. */
  const fileFor = (key: string) => {
    if (!isValidLocalKey(key)) throw new Error("Invalid storage key");
    const file = path.resolve(root, ...key.split("/"));
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid storage key");
    return file;
  };
  const metaFor = (key: string) => `${fileFor(key)}.meta.json`;

  async function readMeta(key: string): Promise<{ contentType: string | null }> {
    try {
      const meta = JSON.parse(await readFile(metaFor(key), "utf8")) as { contentType?: unknown };
      return { contentType: typeof meta.contentType === "string" ? meta.contentType : null };
    } catch {
      return { contentType: null };
    }
  }

  async function write(key: string, data: Uint8Array, contentType: string) {
    const file = fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // Write to a temporary name first so a crash never leaves a half-written object.
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, data);
    await writeFile(metaFor(key), JSON.stringify({ contentType }));
    await rename(temporary, file);
  }

  return {
    id: "local",

    async createUploadUrl({ key, contentType, contentLength, expiresInSeconds }) {
      fileFor(key);
      const exp = Date.now() + expiresInSeconds * 1000;
      const token = sign({ op: "put", key, contentType, length: contentLength, exp });
      return {
        url: `${LOCAL_STORAGE_ROUTE}?token=${token}`,
        method: "PUT",
        headers: { "Content-Type": contentType },
        expiresAt: new Date(exp),
      };
    },

    async head(key) {
      try {
        const info = await stat(fileFor(key));
        return { sizeBytes: info.size, contentType: (await readMeta(key)).contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async readPrefix(key, length) {
      const handle = await open(fileFor(key), "r");
      try {
        const buffer = Buffer.alloc(Math.max(length, 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },

    async getObject(key, maxBytes) {
      const file = fileFor(key);
      if ((await stat(file)).size > maxBytes) {
        throw new Error("Stored object exceeds the processing size limit");
      }
      return new Uint8Array(await readFile(file));
    },

    putObject: (key, data, contentType) => write(key, data, contentType),

    async createDownloadUrl(key, { expiresInSeconds, downloadFilename, contentType }) {
      fileFor(key);
      const exp = Date.now() + expiresInSeconds * 1000;
      const token = sign({ op: "get", key, contentType, filename: downloadFilename, exp });
      return { url: `${LOCAL_STORAGE_ROUTE}?token=${token}`, expiresAt: new Date(exp) };
    },

    async delete(key) {
      await rm(fileFor(key), { force: true });
      await rm(metaFor(key), { force: true });
    },

    verifyToken(token) {
      const [body, mac] = token.split(".");
      if (!body || !mac) return null;
      const expected = createHmac("sha256", config.signingKey).update(body).digest();
      const given = Buffer.from(mac, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let payload: LocalTokenPayload;
      try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LocalTokenPayload;
      } catch {
        return null;
      }
      if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
      if (typeof payload.key !== "string" || !isValidLocalKey(payload.key)) return null;
      return payload;
    },

    writeUpload: (key, data, contentType) => write(key, data, contentType),

    async readForDownload(key) {
      try {
        return new Uint8Array(await readFile(fileFor(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
