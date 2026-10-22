import { z } from "zod";

import type { BlockInfo } from "@/lib/documents/docx/template-blocks";

/**
 * FillPlan: how a DOCX client template is filled with a candidate's resume.
 * Produced by the AI from the template's addressable blocks, validated here,
 * completed and checked by `finalizeFillPlan`, then applied deterministically
 * by the template filler.
 *
 * Like the FormattingPlan, it never carries resume text: every block that
 * changes names a *reference* ("contact.fullName", "summary", "entry.dates")
 * and the filler copies the actual words from ResumeContent. The AI can only
 * decide which template block shows which piece of the resume, which sample
 * blocks go, and which run of blocks repeats per resume entry.
 *
 *   fills   block → references, one per tab-separated segment of the block
 *   clears  sample blocks (paragraphs, cells or whole rows) with no resume equivalent
 *   groups  one sample entry's blocks (paragraphs, or rows of one table) that
 *           are cloned for every entry (or item) of a resume section
 */

export const BLOCK_ID_PATTERN = /^(?:p\d{1,4}|t\d{1,3}\.r\d{1,4}\.c\d{1,3})$/;
export const ROW_ID_PATTERN = /^t\d{1,3}\.r\d{1,4}$/;

export const CONTACT_REFS = [
  "contact.fullName",
  "contact.headline",
  "contact.email",
  "contact.phone",
  "contact.location",
  "contact.links",
] as const;

/** Fields of one entry usable inside a repeat group (or as "sN.eM.<field>"). */
export const ENTRY_FIELDS = [
  "heading",
  "subheading",
  "location",
  "dates",
  "startDate",
  "endDate",
  "description",
  "bullets",
  "text",
  "item",
] as const;
export type EntryField = (typeof ENTRY_FIELDS)[number];

const ENTRY_FIELD = ENTRY_FIELDS.join("|");
const CONTACT_REF = CONTACT_REFS.map((ref) => ref.replace(".", "\\.")).join("|");
const ENTRY_REF = `(?:s\\d{1,2}\\.e\\d{1,3}|entry)\\.(?:${ENTRY_FIELD})`;
/**
 * "-" empties a segment (a sample value with no resume equivalent).
 * One reference, or several scalar ones joined with "+" (shown in one segment
 * separated by ", "; contact fields by " | "): contact.<field> | summary |
 * sN | sN.eM.<field> | entry.<field> (inside a group only).
 */
export const FILL_REF_PATTERN = new RegExp(
  `^(?:-|summary|s\\d{1,2}|(?:${CONTACT_REF})(?:\\+(?:${CONTACT_REF}))*|${ENTRY_REF}(?:\\+${ENTRY_REF})*)$`,
);

/**
 * Tolerated spelling of a reference: separators typed in as text
 * (`s2.e0.heading+" - "+s2.e0.subheading`), spaces and stray "+" are dropped
 * — the engine adds the separators itself.
 */
function cleanRef(ref: string): string {
  return ref
    .replace(/"[^"]*"|'[^']*'/g, "+")
    .replace(/\s+/g, "")
    .replace(/\+{2,}/g, "+")
    .replace(/^\+|\+$/g, "");
}

const blockId = z.string().trim().regex(BLOCK_ID_PATTERN);
const rowId = z.string().trim().regex(ROW_ID_PATTERN);
const fillRef = z.string().transform(cleanRef).pipe(z.string().regex(FILL_REF_PATTERN));
const sectionRef = z
  .string()
  .trim()
  .regex(/^s\d{1,2}$/);

export const fillSchema = z.object({
  block: blockId,
  /** One reference per visible segment of the block; null leaves a segment unchanged. */
  refs: z.array(fillRef.nullable()).min(1).max(12),
});

export const fillGroupSchema = z
  .object({
    /** The resume section whose entries (or items) the group repeats for. */
    source: sectionRef,
    /** entry: one clone per entry; item: one clone per bullet/line (skills, competencies). */
    per: z.enum(["entry", "item"]).default("entry"),
    /** Consecutive body paragraphs forming one sample entry… */
    blocks: z.array(blockId).max(80).default([]),
    /** …or consecutive rows of one table. */
    rows: z.array(rowId).max(20).default([]),
  })
  .refine((group) => group.blocks.length > 0 || group.rows.length > 0, {
    message: "A group needs blocks or rows.",
  });

/** The part produced by the AI. Blocks it does not mention are kept as they are. */
export const aiFillPlanSchema = z.object({
  version: z.literal(1),
  fills: z.array(fillSchema).max(400).default([]),
  clears: z
    .array(z.union([blockId, rowId]))
    .max(600)
    .default([]),
  /** Static blocks after a repeat group that must survive the sample-entry sweep. */
  keeps: z
    .array(z.union([blockId, rowId]))
    .max(200)
    .default([]),
  groups: z.array(fillGroupSchema).max(25).default([]),
  /** Short explanations of mapping decisions (stored for review, never rendered). */
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

export type AIFillPlan = z.infer<typeof aiFillPlanSchema>;
export type FillGroup = z.infer<typeof fillGroupSchema>;
export type Fill = z.infer<typeof fillSchema>;

/** Stored plan: the checked AI plan plus what the checks added (never produced by the AI). */
export const fillPlanSchema = aiFillPlanSchema.extend({
  engine: z.literal("fill"),
  /** Content the template had no block for, shown at the end ("sN.eM", "summary"). */
  additional: z.array(z.string()).default([]),
  /** Contact fields the template has no place for (left out of the document). */
  hiddenContactFields: z.array(z.string()).default([]),
  /** The template has no name line: the name is inserted at the top. */
  insertName: z.boolean().default(false),
  /** Resume sections (indices) whose running text is shown as bullet points. */
  bulletSections: z.array(z.number().int().min(0).max(99)).max(30).default([]),
  /** The summary is shown as bullet points. */
  bulletSummary: z.boolean().default(false),
  source: z.object({
    resumeFileId: z.string().min(1).max(64),
    templateId: z.string().min(1).max(64),
    templateAnalyzedAt: z.string().nullable(),
    engineVersion: z.number().int(),
  }),
});
export type FillPlan = z.infer<typeof fillPlanSchema>;

/** Longest block text sent to the AI (enough to recognise a sample value). */
const MAX_BLOCK_TEXT = 220;
const clip = (text: string) =>
  text.length > MAX_BLOCK_TEXT ? `${text.slice(0, MAX_BLOCK_TEXT)}…` : text;

/** The template blocks as the AI sees them: ids, text, and the few flags that matter. */
export function toAIBlocksView(blocks: BlockInfo[]) {
  return blocks.map((block) => {
    if (block.kind === "table") {
      return {
        id: block.id,
        table: true,
        rows: block.rows.map((row) => ({
          id: row.id,
          cells: row.cells.map((cell) => ({ id: cell.id, text: clip(cell.text) })),
        })),
      };
    }
    return {
      id: block.id,
      ...(block.segments.length > 1
        ? { segments: block.segments.map(clip) }
        : { text: clip(block.text) }),
      ...(block.bold ? { bold: true } : {}),
      ...(block.numbered ? { bullet: true } : {}),
      ...(block.empty ? { empty: true } : {}),
      ...(block.align && block.align !== "left" ? { align: block.align } : {}),
    };
  });
}

/** Splits "a+b" into its parts. */
export const refParts = (ref: string) => ref.split("+");
