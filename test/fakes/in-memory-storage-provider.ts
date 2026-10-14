import type {
  CreateUploadUrlParams,
  StorageKey,
  StorageProvider,
  StoredObjectInfo,
} from "@/lib/storage/types";

/**
 * TEST DOUBLE ONLY — never used by the application. Implements the storage
 * interface in memory so upload verification can be tested without
 * credentials. `simulateBrowserUpload` plays the role of the browser's PUT.
 */
export class InMemoryStorageProvider implements StorageProvider {
  readonly id = "r2" as const;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly issuedUploads: CreateUploadUrlParams[] = [];
  readonly deletedKeys: string[] = [];

  async createUploadUrl(params: CreateUploadUrlParams) {
    this.issuedUploads.push(params);
    return {
      url: `https://storage.invalid/${params.key}?X-Amz-Signature=test-only`,
      method: "PUT" as const,
      headers: { "Content-Type": params.contentType },
      expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000),
    };
  }

  simulateBrowserUpload(key: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(key, { bytes, contentType });
  }

  async head(key: StorageKey): Promise<StoredObjectInfo | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.bytes.length, contentType: object.contentType } : null;
  }

  async readPrefix(key: StorageKey, length: number) {
    return (this.objects.get(key)?.bytes ?? new Uint8Array()).slice(0, length);
  }

  async getObject(key: StorageKey, maxBytes: number) {
    const object = this.objects.get(key);
    if (!object) throw new Error("NoSuchKey");
    if (object.bytes.length > maxBytes) throw new Error("Object too large");
    return object.bytes;
  }

  readonly putKeys: string[] = [];
  /** Set to make the next putObject call fail (simulates a storage outage). */
  failNextPut = false;

  async putObject(key: StorageKey, data: Uint8Array, contentType: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("Simulated storage failure");
    }
    this.putKeys.push(key);
    this.objects.set(key, { bytes: data, contentType });
  }

  async createDownloadUrl(key: StorageKey, params: { expiresInSeconds: number }) {
    return {
      url: `https://storage.invalid/${key}?download=1`,
      expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000),
    };
  }

  async delete(key: StorageKey) {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }
}
