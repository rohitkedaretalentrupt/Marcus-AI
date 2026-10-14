import type { ResumeContent, ResumeEntry } from "@/lib/documents/resume-content";

import type { ContactField, FormattingPlan, PlanSectionKind } from "./plan";

/**
 * Stable references to the pieces of a ResumeContent:
 *   "summary"  the summary text
 *   "s2"       resume section 2 (all of its entries)
 *   "s2.e0"    entry 0 of section 2
 * The AI plans with these references; the renderer resolves them back to text.
 */

export const sectionRef = (sectionIndex: number) => `s${sectionIndex}`;
export const entryRef = (sectionIndex: number, entryIndex: number) =>
  `s${sectionIndex}.e${entryIndex}`;

export interface ResolvedEntryRef {
  sectionIndex: number;
  entryIndex: number;
  entry: ResumeEntry;
}

/** Parses "s2.e0" against the content (null if it does not exist). */
export function resolveEntryRef(content: ResumeContent, ref: string): ResolvedEntryRef | null {
  const match = /^s(\d{1,2})\.e(\d{1,3})$/.exec(ref);
  if (!match) return null;
  const sectionIndex = Number(match[1]);
  const entryIndex = Number(match[2]);
  const entry = content.sections[sectionIndex]?.entries[entryIndex];
  return entry ? { sectionIndex, entryIndex, entry } : null;
}

/** Every content unit that must appear in a complete plan, in resume order. */
export function requiredRefs(content: ResumeContent): string[] {
  const refs: string[] = [];
  if (content.summary) refs.push("summary");
  content.sections.forEach((section, s) => {
    section.entries.forEach((entry, e) => {
      if (hasEntryContent(entry)) refs.push(entryRef(s, e));
    });
  });
  return refs;
}

export function hasEntryContent(entry: ResumeEntry): boolean {
  return Boolean(
    entry.heading ||
    entry.subheading ||
    entry.location ||
    entry.startDate ||
    entry.endDate ||
    entry.description ||
    entry.bullets.some((bullet) => bullet.trim()),
  );
}

/** Contact fields that have a value, in the default display order. */
export function presentContactFields(content: ResumeContent): ContactField[] {
  const { contact } = content;
  const fields: ContactField[] = ["fullName"];
  if (contact.headline) fields.push("headline");
  if (contact.email) fields.push("email");
  if (contact.phone) fields.push("phone");
  if (contact.location) fields.push("location");
  if (contact.links.length > 0) fields.push("links");
  return fields;
}

/**
 * The resume as the plan shows it: contact details the plan's header leaves
 * out (because the template has none) are removed, so the renderer and the
 * validator agree on what the document must contain. The name always stays.
 */
export function contentShownByPlan(
  content: ResumeContent,
  plan: Pick<FormattingPlan, "header">,
): ResumeContent {
  const shown = new Set(plan.header.fields);
  const { contact } = content;
  return {
    ...content,
    contact: {
      fullName: contact.fullName,
      ...(shown.has("headline") && contact.headline ? { headline: contact.headline } : {}),
      ...(shown.has("email") && contact.email ? { email: contact.email } : {}),
      ...(shown.has("phone") && contact.phone ? { phone: contact.phone } : {}),
      ...(shown.has("location") && contact.location ? { location: contact.location } : {}),
      links: shown.has("links") ? contact.links : [],
    },
  };
}

const KIND_BY_TITLE: [RegExp, PlanSectionKind][] = [
  [/\b(awards?|honou?rs|achievements)\b/i, "awards"],
  [/\blanguages?\b/i, "languages"],
];

/** Plan kind for a resume section (custom sections such as "Awards" get their own kind). */
export function planKindForSection(content: ResumeContent, sectionIndex: number): PlanSectionKind {
  const section = content.sections[sectionIndex];
  if (!section) return "custom";
  if (section.kind !== "custom") return section.kind;
  return KIND_BY_TITLE.find(([pattern]) => pattern.test(section.title))?.[1] ?? "custom";
}

/**
 * The resume as sent to the AI: section/entry text with references. Contact
 * details are reduced to which fields exist — the AI only orders them, so
 * the values (personal data) are not sent.
 */
export function toAIResumeView(content: ResumeContent) {
  return {
    contactFieldsPresent: presentContactFields(content),
    linkLabels: content.contact.links.map((link) => link.label),
    summary: content.summary ? { ref: "summary", text: content.summary } : null,
    sections: content.sections.map((section, s) => ({
      ref: sectionRef(s),
      kind: planKindForSection(content, s),
      title: section.title,
      entries: section.entries.map((entry, e) => ({ ref: entryRef(s, e), ...entry })),
    })),
  };
}
