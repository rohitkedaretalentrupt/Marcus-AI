import "server-only";

import { inflateRawSync } from "node:zlib";

import JSZip from "jszip";

/*
 * Guards against "zip bombs" in uploaded DOCX files before mammoth/jszip
 * decompress them. A 20 MB upload could otherwise expand to gigabytes in
 * memory. Every entry is test-inflated with a hard output cap (zlib
 * `maxOutputLength`), so the check itself never allocates more than the cap
 * and does not trust the sizes declared in the ZIP headers.
 */

export const DOCX_PACKAGE_LIMITS = {
  maxEntries: 1000,
  /** Largest single part once decompressed (document.xml of a long resume is ~1 MB). */
  maxEntryBytes: 30 * 1024 * 1024,
  /** All parts together once decompressed. */
  maxTotalBytes: 60 * 1024 * 1024,
} as const;

export class UnsafePackageError extends Error {
  constructor(reason: string) {
    super(`Unsafe DOCX package: ${reason}`);
    this.name = "UnsafePackageError";
  }
}

const STORED = "\x00\x00";
const DEFLATE = "\x08\x00";

/** Shape of JSZip's internal compressed entry (jszip 3.x `CompressedObject`). */
interface CompressedEntry {
  compression?: { magic?: string };
  compressedContent?: Uint8Array | ArrayBuffer | string;
}

export async function assertSafeDocxPackage(data: Uint8Array): Promise<void> {
  let zip: JSZip;
  try {
    // Reads the central directory only; nothing is decompressed here.
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new UnsafePackageError("not a readable ZIP package");
  }

  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.length > DOCX_PACKAGE_LIMITS.maxEntries) {
    throw new UnsafePackageError("too many entries");
  }

  let total = 0;
  for (const file of entries) {
    const compressed = (file as unknown as { _data?: CompressedEntry })._data;
    const content = compressed?.compressedContent;
    const magic = compressed?.compression?.magic;
    if (!content || typeof content === "string" || magic === undefined) {
      throw new UnsafePackageError("unexpected entry encoding");
    }
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);

    let size: number;
    if (magic === STORED) {
      size = bytes.length;
    } else if (magic === DEFLATE) {
      try {
        size = inflateRawSync(bytes, { maxOutputLength: DOCX_PACKAGE_LIMITS.maxEntryBytes }).length;
      } catch {
        throw new UnsafePackageError("entry too large or corrupt");
      }
    } else {
      throw new UnsafePackageError("unsupported compression");
    }
    if (size > DOCX_PACKAGE_LIMITS.maxEntryBytes) throw new UnsafePackageError("entry too large");
    total += size;
    if (total > DOCX_PACKAGE_LIMITS.maxTotalBytes) {
      throw new UnsafePackageError("package too large when decompressed");
    }
  }
}
