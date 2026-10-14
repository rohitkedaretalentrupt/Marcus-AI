import { apiFetch } from "@/lib/api/client";
import type { FileSummary, UploadAuthorization, UploadInstructions } from "@/lib/files/types";
import type { FilePurpose } from "@/lib/files/validation";
import type { ResumeExtractionView } from "@/lib/resumes/types";

/** Browser calls to the file API. The server derives the user from the session. */

const FILES_API = "/api/files";
const fileApi = (fileId: string) => `${FILES_API}/${encodeURIComponent(fileId)}`;

export function requestUpload(metadata: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  purpose?: FilePurpose;
}) {
  return apiFetch<UploadAuthorization>(FILES_API, { method: "POST", body: metadata });
}

export function confirmUpload(fileId: string) {
  return apiFetch<FileSummary>(`${fileApi(fileId)}/confirm`, { method: "POST" });
}

export function discardUpload(fileId: string) {
  return apiFetch<void>(fileApi(fileId), { method: "DELETE" });
}

/** The direct-to-storage PUT failed (network, CORS, expired URL, rejected signature). */
export class UploadTransferError extends Error {
  constructor(readonly status: number) {
    super(`Upload transfer failed with status ${status}`);
    this.name = "UploadTransferError";
  }
}

/**
 * PUTs the file straight to object storage with the presigned URL. Uses
 * XMLHttpRequest because it is the only browser API that reports upload
 * progress. The File is streamed by the browser (no base64, no full read).
 */
export function uploadToStorage(
  upload: UploadInstructions,
  file: File,
  options: { signal: AbortSignal; onProgress: (fraction: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new UploadTransferError(xhr.status));
    xhr.onerror = () => reject(new UploadTransferError(0));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

    if (options.signal.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function getExtraction(fileId: string) {
  return apiFetch<ResumeExtractionView>(`${fileApi(fileId)}/extraction`, { method: "GET" });
}
