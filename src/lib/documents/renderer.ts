import "server-only";

import { NotImplementedError } from "@/lib/errors/app-error";

import { createDocxRenderer } from "./docx/docx-renderer";
import type { DocumentFormat, DocumentRenderer } from "./types";

/**
 * Resolves the renderer for an output format so callers never import a
 * document library directly. DOCX is implemented; PDF is not yet.
 */
export function getDocumentRenderer(format: DocumentFormat): DocumentRenderer {
  if (format === "docx") return createDocxRenderer();
  throw new NotImplementedError(`document renderer for "${format}"`);
}
