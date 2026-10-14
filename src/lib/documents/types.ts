import type { FormattingPlan } from "@/lib/formatting/plan";

import type { ResumeContent } from "./resume-content";

export const DOCUMENT_FORMATS = ["pdf", "docx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const satisfies Record<DocumentFormat, string>;

/** Content is the source of truth; the (finalized) plan only controls presentation. */
export interface RenderDocumentRequest {
  content: ResumeContent;
  plan: FormattingPlan;
}

export interface RenderedDocument {
  format: DocumentFormat;
  mimeType: (typeof DOCUMENT_MIME_TYPES)[DocumentFormat];
  data: Uint8Array;
}

/** Turns structured resume content + a formatting plan into an output file. One per format. Deterministic. */
export interface DocumentRenderer {
  readonly format: DocumentFormat;
  render(request: RenderDocumentRequest): Promise<RenderedDocument>;
}

export interface ExtractedDocument {
  text: string;
  pageCount?: number;
}

/** Pulls text out of an uploaded resume (PDF, DOCX, image via OCR, ...). */
export interface DocumentTextExtractor {
  supports(mimeType: string): boolean;
  extract(data: Uint8Array, mimeType: string): Promise<ExtractedDocument>;
}
