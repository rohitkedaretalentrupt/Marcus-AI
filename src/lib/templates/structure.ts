import { z } from "zod";

import { RESUME_SECTION_KINDS } from "@/lib/documents/resume-content";

/**
 * Structure of a client template as identified by the AI from the template
 * document. Untrusted model output: always parsed through this schema before
 * it is stored or used. `version` allows later migrations.
 */

export const TEMPLATE_SECTION_KINDS = ["summary", ...RESUME_SECTION_KINDS] as const;
export const HEADER_FIELDS = [
  "fullName",
  "headline",
  "email",
  "phone",
  "location",
  "links",
  "photo",
  "candidateId",
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const unknownOr = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum([...values, "unknown"] as [...T, "unknown"]).default("unknown");

export const templateSectionSchema = z.object({
  kind: z.enum(TEMPLATE_SECTION_KINDS),
  /** Heading exactly as written in the template (e.g. "PROFESSIONAL EXPERIENCE"). */
  heading: text(120),
  /** How content is laid out in this section (e.g. "bullets", "dates right-aligned"). */
  contentHints: z.array(text(200)).max(10).default([]),
});

export const clientTemplateStructureSchema = z.object({
  version: z.literal(1),
  /** One or two sentences describing the template. */
  summary: text(500),
  /** Sections in the order they appear. */
  sections: z.array(templateSectionSchema).min(1).max(30),
  header: z.object({
    fields: z.array(z.enum(HEADER_FIELDS)).max(HEADER_FIELDS.length).default([]),
    alignment: unknownOr(["left", "center", "right"] as const),
  }),
  layout: z.object({
    columns: z.union([z.literal(1), z.literal(2)]).default(1),
    pageSize: unknownOr(["letter", "a4"] as const),
    margins: unknownOr(["narrow", "normal", "wide"] as const),
    dateAlignment: unknownOr(["left", "right", "inline"] as const),
    bulletStyle: text(40).optional(),
    sectionDividers: z.boolean().optional(),
  }),
  typography: z.object({
    headingFont: text(100).optional(),
    bodyFont: text(100).optional(),
    headingCase: unknownOr(["upper", "title", "sentence"] as const),
    baseSizePt: z.number().min(6).max(20).optional(),
    headingSizePt: z.number().min(6).max(40).optional(),
  }),
  /** Placeholder / content areas found in the template (e.g. "[Candidate Name]"). */
  placeholders: z
    .array(z.object({ text: text(200), meaning: text(200) }))
    .max(50)
    .default([]),
  /** Other explicit rules (e.g. "no photo", "max 2 pages"). */
  notes: z.array(text(300)).max(20).default([]),
});

export type ClientTemplateStructure = z.infer<typeof clientTemplateStructureSchema>;
export type TemplateSection = z.infer<typeof templateSectionSchema>;
