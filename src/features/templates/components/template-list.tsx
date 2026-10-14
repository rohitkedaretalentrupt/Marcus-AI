"use client";

import { ChevronRight, FileText } from "lucide-react";
import Link from "next/link";

import { useRefreshWhile } from "@/hooks/use-refresh-while";
import { templatePath } from "@/lib/templates/routes";
import type { TemplateSummary } from "@/lib/templates/types";

import { TemplateStatusBadge } from "./template-status-badge";
import { ViewTemplateButton } from "./template-viewer";

export function TemplateList({ templates }: { templates: TemplateSummary[] }) {
  useRefreshWhile(templates.some((template) => template.status === "PROCESSING"));

  return (
    <ul className="divide-y rounded-xl border">
      {templates.map((template) => (
        <li key={template.id} className="relative flex items-center gap-2 hover:bg-accent/50">
          {/* The row opens the details; View sits on top of it as its own button. */}
          <Link
            href={templatePath(template.id)}
            className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 pl-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{template.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {template.filename}
              </span>
            </span>
            {/* Ready is the normal state: only show a badge when something is pending or wrong. */}
            {template.status !== "READY" ? (
              <TemplateStatusBadge status={template.status} awaitingAI={template.awaitingAI} />
            ) : null}
          </Link>
          <ViewTemplateButton
            templateId={template.id}
            name={template.name}
            filename={template.filename}
          />
          <Link
            href={templatePath(template.id)}
            tabIndex={-1}
            aria-hidden="true"
            className="flex min-h-16 items-center pr-4 pl-1"
          >
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
