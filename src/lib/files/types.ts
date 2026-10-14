import type { ExtractionStatus } from "@/lib/resumes/types";

import type { FileKind, SupportedMimeType } from "./file-types";
import type { FilePurpose } from "./validation";

/** Mirrors the Prisma `UploadedFileStatus` enum for isomorphic code. */
export const UPLOADED_FILE_STATUSES = [
  "PENDING_UPLOAD",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETED",
] as const;
export type UploadedFileStatus = (typeof UPLOADED_FILE_STATUSES)[number];

/** Statuses in which a file's object has been verified and it may be attached/downloaded. */
export const USABLE_FILE_STATUSES = [
  "UPLOADED",
  "PROCESSING",
  "READY",
] as const satisfies readonly UploadedFileStatus[];

/** Safe-to-expose file metadata. Never includes the storage key or the owner id. */
export interface FileSummary {
  id: string;
  filename: string;
  mimeType: SupportedMimeType;
  kind: FileKind;
  sizeBytes: number;
  status: UploadedFileStatus;
  purpose: FilePurpose;
  /** Resume text extraction (PDF/DOCX only); null if never attempted. */
  extractionStatus: ExtractionStatus | null;
}

/** What the browser needs to PUT the bytes straight to object storage. */
export interface UploadInstructions {
  url: string;
  method: "PUT";
  /** Must be sent exactly as given: they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface UploadAuthorization {
  file: FileSummary;
  upload: UploadInstructions;
}
