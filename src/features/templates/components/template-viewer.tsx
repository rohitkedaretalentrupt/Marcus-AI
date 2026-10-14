"use client";

import { Eye, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-alert";
import { useTheme } from "@/components/theme-toggle";
import { apiErrorFrom } from "@/lib/api/client";
import { cn } from "@/lib/utils/cn";

/** PDF pages rendered at most (a resume template is a page or two). */
const MAX_PAGES = 10;
const MAX_PAGE_CSS_WIDTH = 900;

type Loaded =
  | { kind: "pdf"; bytes: ArrayBuffer }
  | { kind: "docx"; html: string }
  | { kind: "error"; message: string };

const previewUrl = (templateId: string) =>
  `/api/templates/${encodeURIComponent(templateId)}/preview`;

async function loadPreview(templateId: string, signal: AbortSignal): Promise<Loaded> {
  const response = await fetch(previewUrl(templateId), { signal });
  if (!response.ok) return { kind: "error", message: (await apiErrorFrom(response)).message };
  if (response.headers.get("content-type")?.includes("application/pdf")) {
    return { kind: "pdf", bytes: await response.arrayBuffer() };
  }
  const body = (await response.json()) as { data: { html: string } };
  return { kind: "docx", html: body.data.html };
}

/**
 * Renders the PDF's pages to canvases in the browser (pdf.js via unpdf), so it
 * looks the same on every device — phones included, where an embedded PDF
 * often won't show. In dark mode the pages are colour-inverted (hue kept).
 */
function PdfPages({ bytes }: { bytes: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    (async () => {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
      const cssWidth = Math.min(container.clientWidth || MAX_PAGE_CSS_WIDTH, MAX_PAGE_CSS_WIDTH);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      for (let number = 1; number <= Math.min(pdf.numPages, MAX_PAGES); number++) {
        if (cancelled) return;
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({
          scale: (cssWidth / page.getViewport({ scale: 1 }).width) * pixelRatio,
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className =
          "block h-auto w-full rounded-md bg-white shadow-sm ring-1 ring-border dark:invert dark:hue-rotate-180";
        canvas.setAttribute("aria-label", `Page ${number}`);
        canvas.setAttribute("role", "img");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (cancelled) return;
        container.append(canvas);
      }
      if (!cancelled) setRendering(false);
    })().catch(() => {
      if (!cancelled) {
        setError("This PDF couldn't be displayed. Download it from the template's file instead.");
        setRendering(false);
      }
    });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [bytes]);

  return (
    <>
      {rendering ? <Opening /> : null}
      <FormAlert message={error} />
      <div ref={containerRef} className="mx-auto flex w-full max-w-[900px] flex-col gap-4" />
    </>
  );
}

/** Colours for the sandboxed DOCX page, following the app theme. */
const DOC_THEME = {
  light: {
    background: "#ffffff",
    text: "#111111",
    muted: "#525252",
    border: "#d4d4d4",
    link: "#dc2626",
  },
  dark: {
    background: "#0a0a0a",
    text: "#ededed",
    muted: "#a3a3a3",
    border: "#2a2a2a",
    link: "#f87171",
  },
} as const;

/**
 * A DOCX shown as sanitized HTML inside a sandboxed iframe (no scripts, no
 * same-origin access), styled in the current theme.
 */
function DocxPage({ html }: { html: string }) {
  const [theme] = useTheme();
  const colors = DOC_THEME[theme === "dark" ? "dark" : "light"];
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { color-scheme: ${theme === "dark" ? "dark" : "light"}; }
    body { margin: 0; padding: 24px 20px 40px; background: ${colors.background}; color: ${colors.text};
      font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-wrap: anywhere; }
    main { max-width: 760px; margin: 0 auto; }
    h1, h2, h3, h4 { line-height: 1.3; margin: 1.2em 0 0.4em; }
    h1 { font-size: 1.25em; } h1.title { font-size: 1.6em; margin-top: 0; } h2 { font-size: 1.1em; } h3, h4 { font-size: 1em; }
    p { margin: 0.35em 0; }
    ul, ol { padding-left: 1.4em; }
    a { color: ${colors.link}; }
    table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
    td, th { border: 1px solid ${colors.border}; padding: 6px 8px; vertical-align: top; }
    hr { border: 0; border-top: 1px solid ${colors.border}; }
    em { color: ${colors.muted}; }
  </style></head><body><main>${html}</main></body></html>`;

  return (
    <iframe
      title="Template document"
      // No allow-scripts: nothing in the document can run. allow-same-origin
      // only lets this page size and read the frame (safe without scripts).
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="h-full min-h-[60dvh] w-full rounded-md border bg-background"
    />
  );
}

function Opening() {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      Opening the template…
    </p>
  );
}

function ViewerBody({ templateId }: { templateId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadPreview(templateId, controller.signal).then(setLoaded, () => {
      if (!controller.signal.aborted) {
        setLoaded({
          kind: "error",
          message: "Couldn't open the template. Check your connection and try again.",
        });
      }
    });
    return () => controller.abort();
  }, [templateId]);

  if (!loaded) return <Opening />;
  if (loaded.kind === "error") return <FormAlert message={loaded.message} />;
  return loaded.kind === "pdf" ? (
    <PdfPages bytes={loaded.bytes} />
  ) : (
    <DocxPage html={loaded.html} />
  );
}

/**
 * "View" button + full-screen viewer for the uploaded client template (PDF or
 * DOCX). Follows the app's light/dark theme.
 */
export function ViewTemplateButton({
  templateId,
  name,
  filename,
  className,
}: {
  templateId: string;
  name: string;
  filename: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn("shrink-0", className)}
        onClick={() => setOpen(true)}
        aria-label={`View ${name}`}
      >
        <Eye aria-hidden="true" />
        <span className="max-[400px]:sr-only">View</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[calc(100dvh-2rem)] max-w-5xl flex-col gap-3 p-3 sm:top-1/2 sm:h-[90dvh] sm:p-4">
          <div className="flex min-h-11 items-center gap-2 pr-12">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base">{name}</DialogTitle>
              <DialogDescription className="truncate text-xs">{filename}</DialogDescription>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md bg-muted/40 p-2 sm:p-4">
            {open ? <ViewerBody templateId={templateId} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
