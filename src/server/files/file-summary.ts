import "server-only";

import { getFileType, isSupportedMimeType } from "@/lib/files/file-types";
import type { FileSummary } from "@/lib/files/types";

/** Columns safe to expose. Never includes the storage key or the owner id. */
export const fileSummarySelect = {
  id: true,
  originalFilename: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  purpose: true,
  extraction: { select: { status: true } },
} as const;

interface FileSummaryRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: FileSummary["status"];
  purpose: "ATTACHMENT" | "TEMPLATE";
  extraction: { status: NonNullable<FileSummary["extractionStatus"]> } | null;
}

export function toFileSummary(row: FileSummaryRow): FileSummary {
  // Rows are only ever created with a supported type; anything else is corruption.
  if (!isSupportedMimeType(row.mimeType)) throw new Error(`Unsupported stored type for ${row.id}`);
  return {
    id: row.id,
    filename: row.originalFilename,
    mimeType: row.mimeType,
    kind: getFileType(row.mimeType).kind,
    sizeBytes: row.sizeBytes,
    status: row.status,
    purpose: row.purpose === "TEMPLATE" ? "template" : "attachment",
    extractionStatus: row.extraction?.status ?? null,
  };
}
