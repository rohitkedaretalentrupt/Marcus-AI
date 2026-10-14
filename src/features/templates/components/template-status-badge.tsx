import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";

import type { TemplateStatus } from "@/lib/templates/types";
import { cn } from "@/lib/utils/cn";

const LABELS: Record<TemplateStatus, string> = {
  PROCESSING: "Analysing…",
  READY: "Ready",
  FAILED: "Failed",
};

export function TemplateStatusBadge({
  status,
  awaitingAI = false,
}: {
  status: TemplateStatus;
  /** Saved but waiting for the AI service: shown as a neutral state, not a failure. */
  awaitingAI?: boolean;
}) {
  if (awaitingAI) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <Clock className="size-3" aria-hidden="true" />
        Waiting for AI
      </span>
    );
  }
  const Icon = status === "PROCESSING" ? Loader2 : status === "READY" ? CheckCircle2 : AlertCircle;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "READY" && "border-foreground/40 text-foreground",
        status === "FAILED" && "border-destructive/40 text-destructive",
        status === "PROCESSING" && "text-muted-foreground",
      )}
    >
      <Icon
        className={cn("size-3", status === "PROCESSING" && "animate-spin")}
        aria-hidden="true"
      />
      {LABELS[status]}
    </span>
  );
}
