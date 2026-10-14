"use client";

import { FileText, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError } from "@/lib/api/client";
import { formatFileSize } from "@/lib/files/limits";
import { templatePath } from "@/lib/templates/routes";
import { TEMPLATE_NAME_MAX, templateNameSchema } from "@/lib/templates/types";

import { createTemplate, TEMPLATE_FILE_ACCEPT, uploadTemplateFile } from "../lib/template-api";

type Phase = "idle" | "uploading" | "creating";

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.displayMessage;
  if (error instanceof Error && !(error instanceof DOMException)) return error.message;
  return "Upload failed. Please try again.";
}

/** Upload a PDF/DOCX client template and start its analysis. */
export function NewTemplateDialog({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = phase !== "idle";

  function reset() {
    abort.current?.abort();
    setName("");
    setFile(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsedName = templateNameSchema.safeParse(name);
    if (!parsedName.success)
      return setError(parsedName.error.issues[0]?.message ?? "Enter a name.");
    if (!file) return setError("Choose a PDF or DOCX template file.");

    setError(null);
    abort.current = new AbortController();
    try {
      setPhase("uploading");
      const uploaded = await uploadTemplateFile(file, {
        signal: abort.current.signal,
        onProgress: setProgress,
      });
      setPhase("creating");
      const template = await createTemplate(parsedName.data, uploaded.id);
      setOpen(false);
      reset();
      router.push(templatePath(template.id));
      router.refresh();
    } catch (caught) {
      if (abort.current?.signal.aborted) return;
      setError(messageFor(caught));
      setPhase("idle");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button onClick={() => setOpen(true)} disabled={disabled}>
        <Plus aria-hidden="true" />
        New template
      </Button>
      <DialogContent>
        <form onSubmit={handleSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New client template</DialogTitle>
            <DialogDescription>
              Upload the client&apos;s resume template (PDF or DOCX). It&apos;s stored unchanged and
              analysed to identify its sections and layout.
            </DialogDescription>
          </DialogHeader>

          <FormAlert message={error} />

          <div className="grid gap-2">
            <Label htmlFor="template-name">Template name</Label>
            <Input
              id="template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={TEMPLATE_NAME_MAX}
              placeholder="e.g. Client A"
              autoComplete="off"
              disabled={busy}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="template-file">Template file</Label>
            <Input
              id="template-file"
              type="file"
              accept={TEMPLATE_FILE_ACCEPT}
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
            />
            {file ? (
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0">· {formatFileSize(file.size)}</span>
              </p>
            ) : null}
          </div>

          {phase === "uploading" ? (
            <div
              role="progressbar"
              aria-label="Uploading template"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {phase === "uploading" ? "Uploading…" : phase === "creating" ? "Saving…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
