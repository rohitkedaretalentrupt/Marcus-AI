"use client";

import { FileText, Image as ImageIcon, Loader2, RotateCw, X } from "lucide-react";
import { useId } from "react";

import { formatFileSize } from "@/lib/files/limits";
import { cn } from "@/lib/utils/cn";

import type { ComposerAttachment } from "../hooks/use-attachment-uploads";

interface AttachmentTrayProps {
  items: ComposerAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}

/** Compact, horizontally scrolling previews above the message input. */
export function AttachmentTray({ items, onRemove, onRetry }: AttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex gap-2 overflow-x-auto px-1 pt-1 pb-2">
      {items.map((item) => (
        <AttachmentPreview key={item.localId} item={item} onRemove={onRemove} onRetry={onRetry} />
      ))}
    </ul>
  );
}

const PHASE_LABEL: Record<ComposerAttachment["phase"], string> = {
  checking: "Checking…",
  preparing: "Preparing…",
  uploading: "Uploading…",
  verifying: "Verifying…",
  ready: "Uploaded",
  failed: "Failed",
};

function AttachmentPreview({
  item,
  onRemove,
  onRetry,
}: {
  item: ComposerAttachment;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const nameId = useId();
  const failed = item.phase === "failed";
  const percent = item.progress === null ? null : Math.round(item.progress * 100);

  return (
    <li
      className={cn(
        "relative flex w-56 max-w-[70vw] shrink-0 items-center gap-2.5 rounded-xl border bg-background p-2 pr-9",
        failed && "border-destructive/50",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        {item.previewUrl ? (
          // Local blob preview of the user's own file; nothing is fetched remotely.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt="" className="size-full object-cover" />
        ) : item.kind === "image" ? (
          <ImageIcon className="size-5" aria-hidden="true" />
        ) : (
          <FileText className="size-5" aria-hidden="true" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span id={nameId} className="block truncate text-sm font-medium" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {item.phase !== "ready" && !failed ? (
            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          ) : null}
          {failed ? (
            <span
              role="alert"
              className="truncate text-destructive"
              title={item.error ?? undefined}
            >
              {item.error}
            </span>
          ) : (
            <span aria-live="polite">
              {item.phase === "ready" ? formatFileSize(item.file.size) : PHASE_LABEL[item.phase]}
            </span>
          )}
          {percent !== null ? <span aria-hidden="true">{percent}%</span> : null}
        </span>
        {item.phase === "uploading" ? (
          <span
            role="progressbar"
            aria-labelledby={nameId}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full bg-primary transition-[width]"
              style={{ width: `${percent ?? 0}%` }}
            />
          </span>
        ) : null}
      </span>

      {failed && item.retryable ? (
        <button
          type="button"
          onClick={() => onRetry(item.localId)}
          aria-label="Retry upload"
          aria-describedby={nameId}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <RotateCw className="size-4" aria-hidden="true" />
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => onRemove(item.localId)}
        aria-label="Remove attachment"
        aria-describedby={nameId}
        className="absolute top-1 right-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}
