import { z } from "zod";

/**
 * FormattingPlan: how existing resume content is mapped into a client
 * template. Produced by the AI, validated here, completed and checked by
 * `finalizePlan`, then rendered deterministically.
 *
 * The plan never carries resume text. Sections list *references* to content
 * ("summary", "s2" = a whole resume section, "s2.e0" = one entry), and the
 * renderer pulls the actual words from ResumeContent. The AI therefore cannot
 * invent or reword facts: it can only choose order, grouping, headings and
 * styling. There is no field for HTML, XML, scripts or raw document markup.
 */

export const CONTENT_REF_PATTERN = /^(?:summary|s\d{1,2}(?:\.e\d{1,3})?)$/;
export const contentRefSchema = z.string().trim().regex(CONTENT_REF_PATTERN);

export const PLAN_SECTION_KINDS = [
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "awards",
  "languages",
  "custom",
] as const;
export type PlanSectionKind = (typeof PLAN_SECTION_KINDS)[number];

/**
 * entries:   title line (dates per `entries.datePosition`), sub-line, text, bullets
 * bullets:   every item as a bullet point
 * inline:    items joined on one line per entry (e.g. skills)
 * paragraph: running text
 * table:     dates column + details column
 */
export const SECTION_LAYOUTS = ["entries", "bullets", "inline", "paragraph", "table"] as const;
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];

export const CONTACT_FIELDS = [
  "fullName",
  "headline",
  "email",
  "phone",
  "location",
  "links",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export const BULLET_SYMBOLS = ["•", "–", "▪", "◦", "➢", "✓"] as const;
export const HEADER_SEPARATORS = ["|", "•", "·", "–", ","] as const;
export const DATE_SEPARATORS = ["–", "-", "to"] as const;

const heading = z.string().trim().min(1).max(120);
/** Six-digit hex colour, stored without "#", upper-case. */
const color = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((value) => value.replace("#", "").toUpperCase());
/** A font family name only (letters, digits, spaces, hyphens). */
const fontName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/);

export const planSectionSchema = z.object({
  heading,
  kind: z.enum(PLAN_SECTION_KINDS),
  layout: z.enum(SECTION_LAYOUTS).default("entries"),
  /** Content references in display order. */
  sources: z.array(contentRefSchema).min(1).max(120),
  /**
   * Entry descriptions shown as bullet points, one per sentence (wording
   * unchanged) — when the template shows this section's details as bullets.
   */
  textAsBullets: z.boolean().default(false),
  /** Bullets layout only: a short label (the resume section title) before each source section's items. */
  groupBySource: z.boolean().default(false),
  /** Used only with two columns. */
  column: z.enum(["main", "side"]).default("main"),
  pageBreakBefore: z.boolean().default(false),
});

/** The part produced by the AI. Ranges are sanity bounds; the renderer clamps further for readability. */
export const aiFormattingPlanSchema = z.object({
  version: z.literal(1),
  header: z
    .object({
      /** Contact fields to show, in display order: only those the template has (the name is always shown). */
      fields: z.array(z.enum(CONTACT_FIELDS)).max(CONTACT_FIELDS.length).default([]),
      alignment: z.enum(["left", "center", "right"]).default("left"),
      contactLayout: z.enum(["inline", "stacked"]).default("inline"),
      separator: z.enum(HEADER_SEPARATORS).default("|"),
    })
    .prefault({}),
  sections: z.array(planSectionSchema).min(1).max(40),
  page: z
    .object({
      size: z.enum(["letter", "a4"]).default("letter"),
      marginsInches: z
        .object({
          top: z.number().min(0).max(3),
          right: z.number().min(0).max(3),
          bottom: z.number().min(0).max(3),
          left: z.number().min(0).max(3),
        })
        .optional(),
      columns: z.union([z.literal(1), z.literal(2)]).default(1),
      sideColumn: z.enum(["left", "right"]).default("left"),
      sideColumnWidthPercent: z.number().min(15).max(50).default(30),
    })
    .prefault({}),
  typography: z
    .object({
      bodyFont: fontName.optional(),
      headingFont: fontName.optional(),
      bodySizePt: z.number().min(5).max(20).optional(),
      headingSizePt: z.number().min(5).max(40).optional(),
      nameSizePt: z.number().min(5).max(60).optional(),
      headingCase: z.enum(["upper", "title", "as_written"]).default("as_written"),
      headingBold: z.boolean().default(true),
      headingUnderline: z.boolean().default(false),
      textColor: color.optional(),
      headingColor: color.optional(),
      linkColor: color.optional(),
    })
    .prefault({}),
  spacing: z
    .object({
      lineSpacing: z.number().min(0.8).max(3).default(1.05),
      paragraphAfterPt: z.number().min(0).max(36).default(2),
      sectionBeforePt: z.number().min(0).max(48).default(10),
      entryGapPt: z.number().min(0).max(36).default(6),
    })
    .prefault({}),
  entries: z
    .object({
      titleOrder: z.enum(["heading_first", "subheading_first"]).default("heading_first"),
      datePosition: z.enum(["right", "inline", "below"]).default("right"),
      dateSeparator: z.enum(DATE_SEPARATORS).default("–"),
      subheadingItalic: z.boolean().default(true),
    })
    .prefault({}),
  bullets: z
    .object({
      symbol: z.enum(BULLET_SYMBOLS).default("•"),
      indentInches: z.number().min(0).max(1.5).default(0.25),
    })
    .prefault({}),
  dividers: z
    .object({
      underHeadings: z.boolean().default(false),
      color: color.optional(),
    })
    .prefault({}),
  footer: z.object({ pageNumbers: z.boolean().default(false) }).prefault({}),
  /** Short explanations of mapping decisions (stored for review, never rendered). */
  // Trimmed rather than rejected: a chatty plan is still a good plan.
  notes: z
    .array(z.string())
    .default([])
    .transform((notes) =>
      notes
        .map((note) => note.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 10),
    ),
});

/** Stored plan: the AI plan plus server-set provenance (never produced by the AI). */
export const formattingPlanSchema = aiFormattingPlanSchema.extend({
  source: z.object({
    resumeFileId: z.string().min(1).max(64),
    templateId: z.string().min(1).max(64),
    templateAnalyzedAt: z.string().nullable(),
    engineVersion: z.number().int(),
  }),
});

export type AIFormattingPlan = z.infer<typeof aiFormattingPlanSchema>;
export type FormattingPlan = z.infer<typeof formattingPlanSchema>;
export type PlanSection = z.infer<typeof planSectionSchema>;
