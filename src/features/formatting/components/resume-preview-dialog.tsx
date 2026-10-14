"use client";

import { Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-alert";
import { apiErrorFrom, ApiRequestError } from "@/lib/api/client";

const previewUrl = (jobId: string) => `/api/formatting-jobs/${encodeURIComponent(jobId)}/preview`;

/**
 * Renders the generated DOCX in the browser (docx-preview: pages, fonts,
 * bullets, tab-aligned dates), scaled down to fit narrow screens. Styling
 * for the dark theme lives in globals.css (.resume-preview).
 */
function ResumePages({ jobId }: { jobId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | string>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();

    const fit = () => {
      const page = container.querySelector<HTMLElement>("section.docx");
      const wrapper = container.querySelector<HTMLElement>(".docx-wrapper");
      if (!page || !wrapper) return;
      wrapper.style.zoom = "1";
      const scale = Math.min(1, (container.clientWidth - 16) / page.offsetWidth);
      wrapper.style.zoom = String(scale);
    };

    (async () => {
      const response = await fetch(previewUrl(jobId), { signal: controller.signal });
      if (!response.ok) throw await apiErrorFrom(response);
      const data = await response.blob();
      const { renderAsync } = await import("docx-preview");
      if (controller.signal.aborted) return;
      await renderAsync(data, container, undefined, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true,
      });
      if (controller.signal.aborted) return;
      fit();
      setState("ready");
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState(
        error instanceof ApiRequestError
          ? error.message
          : "The preview couldn't be shown. You can still download the file.",
      );
    });

    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => {
      controller.abort();
      observer.disconnect();
      container.replaceChildren();
    };
  }, [jobId]);

  return (
    <>
      {state === "loading" ? (
        <p
          role="status"
          className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Opening the resume…
        </p>
      ) : null}
      {state !== "loading" && state !== "ready" ? <FormAlert message={state} /> : null}
      <div ref={containerRef} className="resume-preview" />
    </>
  );
}

/** Pop-up preview of a generated resume, with Download in its header. */
export function ResumePreviewDialog({
  open,
  onOpenChange,
  jobId,
  title,
  subtitle,
  onDownload,
  downloading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  title: string;
  subtitle: string;
  onDownload: () => void;
  downloading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-2rem)] max-w-5xl flex-col gap-3 p-3 sm:top-1/2 sm:h-[90dvh] sm:p-4">
        <div className="flex min-h-11 items-center gap-2 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription className="truncate text-xs">{subtitle}</DialogDescription>
          </div>
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={onDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3.5" aria-hidden="true" />
            )}
            Download
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md bg-muted/40">
          {open ? <ResumePages jobId={jobId} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
