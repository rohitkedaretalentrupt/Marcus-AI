import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageProvider } from "../../types";

export interface R2Config {
  /** https://<account-id>.r2.cloudflarestorage.com (S3-compatible API endpoint). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function contentDisposition(filename: string): string {
  // ASCII fallback plus RFC 5987 UTF-8 form; quotes/backslashes stripped.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === "NotFound" ||
      error.name === "NoSuchKey" ||
      error.$metadata.httpStatusCode === 404)
  );
}

/**
 * Cloudflare R2 through its S3-compatible API. This is the only module that
 * knows about R2; everything else uses the generic `StorageProvider`.
 */
export function createR2StorageProvider(config: R2Config): StorageProvider {
  const client = new S3Client({
    region: "auto", // R2 ignores regions; "auto" is the documented value.
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Newer SDKs add CRC checksums to every request by default, which would
    // also have to be sent by the browser for presigned PUTs. Only send them
    // where an operation requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;

  return {
    id: "r2",

    async createUploadUrl({ key, contentType, contentLength, expiresInSeconds }) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        // Bind type and exact size into the signature: R2 rejects a PUT whose
        // headers differ, so the URL cannot be reused for another file.
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      return {
        url,
        method: "PUT",
        // Content-Length is set by the browser itself from the File body.
        headers: { "Content-Type": contentType },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      };
    },

    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async readPrefix(key, length) {
      const result = await client.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${Math.max(length, 1) - 1}` }),
      );
      return result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
    },

    async getObject(key, maxBytes) {
      const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if ((result.ContentLength ?? 0) > maxBytes) {
        await result.Body?.transformToWebStream().cancel();
        throw new Error("Stored object exceeds the processing size limit");
      }
      const bytes = result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      if (bytes.length > maxBytes)
        throw new Error("Stored object exceeds the processing size limit");
      return bytes;
    },

    async putObject(key, data, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          ContentLength: data.length,
          CacheControl: "private, no-store",
        }),
      );
    },

    async createDownloadUrl(key, { expiresInSeconds, downloadFilename, contentType }) {
      const command = new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition(downloadFilename),
        ResponseCacheControl: "private, no-store",
      });
      const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
      return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
