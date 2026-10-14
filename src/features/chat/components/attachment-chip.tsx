"use client";

import { FileText, Image as ImageIcon } from "lucide-react";

import { formatFileSize } from "@/lib/files/limits";
import type { FileSummary } from "@/lib/files/types";

import { useExtractionStatus } from "../hooks/use-extraction-status";

const EXTRACTION_LABEL = {
  PROCESSING: "Reading resume…",
  READY: "Resume read",
  FAILED: "Couldn't read text",
} as const;

/**
 * A file the user sent: name, size and whether the resume has been read.
 * Not downloadable — the user already has it; only formatted resumes (the
 * job cards) offer a download.
 */
export function AttachmentChip({ file }: { file: FileSummary }) {
  const Icon = file.kind === "image" ? ImageIcon : FileText;
  const extraction = useExtractionStatus(file.id, file.extractionStatus);

  return (
    <div className="flex w-60 max-w-full items-center gap-2.5 rounded-xl border bg-background p-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{file.filename}</span>
        <span className="block text-xs text-muted-foreground">
          {formatFileSize(file.sizeBytes)}
          {extraction ? <span aria-live="polite"> · {EXTRACTION_LABEL[extraction]}</span> : null}
        </span>
      </span>
    </div>
  );
}
