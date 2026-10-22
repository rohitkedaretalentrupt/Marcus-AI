import { z } from "zod";

import { toSentences } from "@/lib/documents/docx/text";
import type { ResumeContent } from "@/lib/documents/resume-content";

/**
 * Changes a person asks for after (or while) formatting: leave a section out,
 * or show a section's text as bullet points. They are stored on the formatting
 * job and applied to the resume content before it is laid out, so the client's
 * template decides how everything else looks.
 */

const sectionName = z.string().trim().min(1).max(200);

export const formattingEditsSchema = z.object({
  /** Section titles (as the resume has them; "Summary" for the summary) left out of the document. */
  removeSections: z.array(sectionName).max(12).default([]),
  /** Section titles whose text is shown as bullet points. */
  bulletSections: z.array(sectionName).max(12).default([]),
});
export type FormattingEdits = z.infer<typeof formattingEditsSchema>;

export const NO_EDITS: FormattingEdits = { removeSections: [], bulletSections: [] };

export const EDIT_ACTIONS = ["remove", "restore", "bullets", "paragraph"] as const;

/** One change as read from a chat message. */
export const editActionSchema = z.object({
  action: z.enum(EDIT_ACTIONS),
  section: sectionName,
});
export type EditAction = z.infer<typeof editActionSchema>;

export const SUMMARY_SECTION = "Summary";

const key = (title: string) => title.trim().toLowerCase();

export function hasEdits(edits: FormattingEdits | null | undefined): boolean {
  return !!edits && (edits.removeSections.length > 0 || edits.bulletSections.length > 0);
}

/** Parses the stored value of a job's edits (anything unusable means "no edits"). */
export function parseStoredEdits(value: unknown): FormattingEdits {
  const parsed = formattingEditsSchema.safeParse(value);
  return parsed.success ? parsed.data : NO_EDITS;
}

/** The section names a person can refer to: the summary (if any) and every section title. */
export function editableSections(content: ResumeContent): string[] {
  return [...(content.summary ? [SUMMARY_SECTION] : []), ...content.sections.map((s) => s.title)];
}

/** The resume's own spelling of a section a person named (case-insensitive, exact), or null. */
export function resolveSection(content: ResumeContent, wanted: string): string | null {
  return editableSections(content).find((title) => key(title) === key(wanted)) ?? null;
}

const without = (list: string[], title: string) =>
  list.filter((entry) => key(entry) !== key(title));
const withTitle = (list: string[], title: string) =>
  list.some((entry) => key(entry) === key(title)) ? list : [...list, title];

/**
 * The edits after more changes are asked for: "remove" and "restore" (bring a
 * removed section back) undo each other, and so do "bullets" and "paragraph".
 */
export function applyEditActions(
  edits: FormattingEdits,
  actions: readonly EditAction[],
): FormattingEdits {
  let next = { ...edits };
  for (const { action, section } of actions) {
    if (action === "remove") {
      next = {
        removeSections: withTitle(next.removeSections, section),
        bulletSections: without(next.bulletSections, section),
      };
    } else if (action === "restore") {
      next = { ...next, removeSections: without(next.removeSections, section) };
    } else if (action === "bullets") {
      next = {
        removeSections: without(next.removeSections, section),
        bulletSections: withTitle(next.bulletSections, section),
      };
    } else {
      next = { ...next, bulletSections: without(next.bulletSections, section) };
    }
  }
  return next;
}

export interface EditedContent {
  content: ResumeContent;
  /** Indices (in the edited content) of the sections shown as bullets. */
  bulletSections: number[];
  /** The summary is shown as bullets. */
  bulletSummary: boolean;
}

/**
 * Applies the edits to the resume: removed sections (and the summary) are
 * dropped; a bulleted section's entry paragraphs become one bullet per
 * sentence. Everything else is untouched.
 */
export function applyEdits(content: ResumeContent, edits: FormattingEdits): EditedContent {
  const removed = new Set(edits.removeSections.map(key));
  const bulleted = new Set(edits.bulletSections.map(key));

  const bulletSections: number[] = [];
  const sections: ResumeContent["sections"] = [];
  for (const section of content.sections) {
    if (removed.has(key(section.title))) continue;
    if (bulleted.has(key(section.title))) {
      bulletSections.push(sections.length);
      sections.push({
        ...section,
        entries: section.entries.map((entry) => {
          if (!entry.description) return entry;
          const { description: _description, ...rest } = entry;
          return { ...rest, bullets: [...toSentences(entry.description), ...entry.bullets] };
        }),
      });
    } else {
      sections.push(section);
    }
  }

  const summaryRemoved = removed.has(key(SUMMARY_SECTION));
  const { summary, ...rest } = content;
  return {
    content: { ...rest, ...(summary && !summaryRemoved ? { summary } : {}), sections },
    bulletSections,
    bulletSummary: !!summary && !summaryRemoved && bulleted.has(key(SUMMARY_SECTION)),
  };
}

/** Short, human descriptions for a job card ("Without Skills", "Education as bullets"). */
export function describeEdits(edits: FormattingEdits | null | undefined): string[] {
  if (!edits) return [];
  return [
    ...edits.removeSections.map((title) => `Without ${title}`),
    ...edits.bulletSections.map((title) => `${title} as bullets`),
  ];
}
