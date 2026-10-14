"use client";

import { Download, Eye, FileText, Loader2, RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { ApiRequestError } from "@/lib/api/client";
import type { FormattingJobView } from "@/lib/formatting/types";
import { cn } from "@/lib/utils/cn";
import { useIsClient } from "@/features/chat/hooks/use-is-client";

import { downloadFormattedResume, retryFormattingJob } from "../lib/formatting-api";
import { ResumePreviewDialog } from "./resume-preview-dialog";

/** Seconds since `since`, ticking every second (a real clock, not simulated progress). */
function useElapsedSeconds(since: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}

const formatElapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * While a job is queued or running: an animated document being "written", an
 * indeterminate progress bar and the real elapsed time. The animation shows
 * that work is happening; it never pretends to know how far along it is.
 */
function JobInProgress({ job }: { job: FormattingJobView }) {
  const isClient = useIsClient();
  const elapsed = useElapsedSeconds(job.createdAt);
  const queued = job.status === "QUEUED";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div aria-hidden="true" className="formatting-doc">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="min-w-0 flex-1">
          <p role="status" className="thinking-shimmer text-sm font-medium">
            {queued ? "Getting ready to format…" : "Formatting your resume…"}
          </p>
          <p className="text-xs text-muted-foreground">
            {queued
              ? "Waiting for a free slot"
              : `Laying it out in the ${job.template?.name ?? "client"} template`}
            {isClient ? <span className="tabular-nums"> · {formatElapsed(elapsed)}</span> : null}
          </p>
        </div>
      </div>
      <div
        className="formatting-progress"
        role="progressbar"
        aria-label="Formatting in progress"
        aria-busy="true"
      >
        <span />
      </div>
    </div>
  );
}

/** The candidate's name, from the generated file's name ("<Candidate> - <Template>.docx"). */
function candidateName(job: FormattingJobView): string | null {
  const base = job.document?.filename.replace(/\.docx$/i, "");
  if (!base) return null;
  const cut = base.indexOf(" - ");
  return (cut > 0 ? base.slice(0, cut) : base).trim() || null;
}

/** A formatting job as shown in the chat: client (template) and candidate name, Download; progress or Retry while not done. */
export function FormattingJobCard({ job }: { job: FormattingJobView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"download" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = job.status === "QUEUED" || job.status === "PROCESSING";

  async function run(action: "download" | "retry") {
    setBusy(action);
    setError(null);
    try {
      if (action === "download") await downloadFormattedResume(job.id);
      if (action === "retry") await retryFormattingJob(job.id);
      if (action !== "download") router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.displayMessage
          : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  const templateName = job.template?.name ?? "Deleted template";
  const candidate = candidateName(job);
  const [previewOpen, setPreviewOpen] = useState(false);
  const done = job.status === "COMPLETED" && job.document !== null;

  if (done) {
    const title = templateName;
    const subtitle = candidate ? `${candidate} · Word document` : "Word document";
    return (
      <div className="formatting-done w-full max-w-[26rem] space-y-2 rounded-xl border bg-card p-2.5 text-card-foreground">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
          >
            <FileText className="size-4" />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-semibold">{title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
            onClick={() => setPreviewOpen(true)}
            aria-label={`Preview ${title}`}
          >
            <Eye className="size-3" aria-hidden="true" />
            <span className="max-[420px]:sr-only">Preview</span>
          </Button>
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
            onClick={() => run("download")}
            disabled={busy !== null}
            aria-label={`Download ${job.document!.filename}`}
          >
            {busy === "download" ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3" aria-hidden="true" />
            )}
            <span className="max-[420px]:sr-only">Download</span>
          </Button>
        </div>
        <FormAlert message={error} />
        <ResumePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          jobId={job.id}
          title={title}
          subtitle={subtitle}
          onDownload={() => void run("download")}
          downloading={busy === "download"}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border bg-card px-3 py-2.5 text-card-foreground transition-colors",
        active && "border-primary/40 p-4",
        job.status === "COMPLETED" && "formatting-done",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <FileText className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">{templateName}</p>
          {candidate ? <p className="truncate text-xs text-muted-foreground">{candidate}</p> : null}
        </div>
        {job.canRetry ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1.5 px-3 text-xs"
            onClick={() => run("retry")}
            disabled={busy !== null}
          >
            {busy === "retry" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw className="size-3.5" aria-hidden="true" />
            )}
            Retry
          </Button>
        ) : null}
      </div>

      {active ? <JobInProgress job={job} /> : null}
      {job.failureMessage ? <p className="text-xs text-destructive">{job.failureMessage}</p> : null}
      <FormAlert message={error} />
    </div>
  );
}
