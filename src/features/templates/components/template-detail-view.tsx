"use client";

import { Loader2, RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { useRefreshWhile } from "@/hooks/use-refresh-while";
import { ApiRequestError } from "@/lib/api/client";
import { TEMPLATES_PATH } from "@/lib/templates/routes";
import type { ClientTemplateStructure } from "@/lib/templates/structure";
import type { TemplateDetail } from "@/lib/templates/types";

import { deleteTemplate, retryTemplate } from "../lib/template-api";
import { TemplateStatusBadge } from "./template-status-badge";
import { ViewTemplateButton } from "./template-viewer";

const KIND_LABELS: Record<string, string> = {
  summary: "Summary",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certifications: "Certifications",
  custom: "Other",
};

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === "" || value === "unknown") return null;
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
    </div>
  );
}

function StructureView({ structure }: { structure: ClientTemplateStructure }) {
  const { layout, typography, header } = structure;
  return (
    <div className="space-y-8">
      <p className="text-sm text-pretty">{structure.summary}</p>

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading" className="mb-3 text-sm font-semibold">
          Sections (in order)
        </h2>
        <ol className="space-y-2">
          {structure.sections.map((section, index) => (
            <li key={index} className="flex gap-3 rounded-lg border p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">{section.heading}</p>
                <p className="text-xs text-muted-foreground">{KIND_LABELS[section.kind]}</p>
                {section.contentHints.length ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {section.contentHints.map((hint) => (
                      <li key={hint} className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                        {hint}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="layout-heading">
        <h2 id="layout-heading" className="mb-1 text-sm font-semibold">
          Layout & typography
        </h2>
        <dl className="divide-y">
          <Field label="Header fields" value={header.fields.join(", ")} />
          <Field label="Header alignment" value={header.alignment} />
          <Field label="Columns" value={layout.columns} />
          <Field
            label="Page size"
            value={
              layout.pageSize === "a4"
                ? "A4"
                : layout.pageSize === "letter"
                  ? "US Letter"
                  : undefined
            }
          />
          <Field label="Margins" value={layout.margins} />
          <Field
            label="Dates"
            value={
              layout.dateAlignment === "inline"
                ? "inline"
                : layout.dateAlignment !== "unknown"
                  ? `${layout.dateAlignment}-aligned`
                  : undefined
            }
          />
          <Field label="Bullets" value={layout.bulletStyle} />
          <Field
            label="Section dividers"
            value={
              layout.sectionDividers === undefined
                ? undefined
                : layout.sectionDividers
                  ? "yes"
                  : "no"
            }
          />
          <Field label="Heading font" value={typography.headingFont} />
          <Field label="Body font" value={typography.bodyFont} />
          <Field label="Heading case" value={typography.headingCase} />
          <Field
            label="Body size"
            value={typography.baseSizePt ? `${typography.baseSizePt} pt` : undefined}
          />
          <Field
            label="Heading size"
            value={typography.headingSizePt ? `${typography.headingSizePt} pt` : undefined}
          />
        </dl>
      </section>

      {structure.placeholders.length ? (
        <section aria-labelledby="placeholders-heading">
          <h2 id="placeholders-heading" className="mb-2 text-sm font-semibold">
            Placeholders
          </h2>
          <ul className="space-y-1.5 text-sm">
            {structure.placeholders.map((placeholder, index) => (
              <li key={index} className="break-words">
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{placeholder.text}</code>{" "}
                <span className="text-muted-foreground">— {placeholder.meaning}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {structure.notes.length ? (
        <section aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="mb-2 text-sm font-semibold">
            Notes
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {structure.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function TemplateDetailView({ template }: { template: TemplateDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useRefreshWhile(template.status === "PROCESSING");

  async function run(action: "retry" | "delete") {
    setBusy(action);
    setError(null);
    try {
      if (action === "retry") {
        await retryTemplate(template.id);
        router.refresh();
      } else {
        await deleteTemplate(template.id);
        router.replace(TEMPLATES_PATH);
        router.refresh();
        return;
      }
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : "Something went wrong. Please try again.",
      );
    }
    setBusy(null);
    setConfirmOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {/* Ready is the normal state: only show a badge when something is pending or wrong. */}
        {template.status !== "READY" ? (
          <TemplateStatusBadge status={template.status} awaitingAI={template.awaitingAI} />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {template.filename}
        </span>
        <ViewTemplateButton
          templateId={template.id}
          name={template.name}
          filename={template.filename}
        />
      </div>

      <FormAlert message={error} />

      {template.status === "PROCESSING" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Analysing the template. This usually takes under a minute.
        </p>
      ) : null}

      {template.status === "FAILED" ? (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4 text-sm">
          <p>{template.failureMessage}</p>
          <Button variant="outline" size="sm" onClick={() => run("retry")} disabled={busy !== null}>
            {busy === "retry" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw aria-hidden="true" />
            )}
            Try again
          </Button>
        </div>
      ) : null}

      {template.structure ? <StructureView structure={template.structure} /> : null}

      <div className="border-t pt-6">
        <Button variant="outline" onClick={() => setConfirmOpen(true)} className="text-destructive">
          <Trash2 aria-hidden="true" />
          Delete template
        </Button>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => busy === null && setConfirmOpen(next)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes “{template.name}” and its uploaded file. Conversations using
              it will no longer have a template selected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" disabled={busy !== null}>
                Cancel
              </Button>
            </AlertDialogCancel>
            <Button variant="destructive" onClick={() => run("delete")} disabled={busy !== null}>
              {busy === "delete" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {busy === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
