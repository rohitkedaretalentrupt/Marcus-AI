import "server-only";

import JSZip from "jszip";

import {
  CONTACT_REFS,
  refParts,
  type Fill,
  type FillGroup,
  type FillPlan,
} from "@/lib/formatting/fill-plan";
import { resolveEntryRef } from "@/lib/formatting/content-refs";

import type { ResumeContent, ResumeEntry } from "../resume-content";
import { assertSafeDocxPackage } from "./package-safety";
import {
  cellParagraphs,
  cellText,
  describeBlocks,
  describeParagraph,
  emptyParagraph,
  inlineLabel,
  isBold,
  isFieldLabel,
  isHeadingLike,
  isLabelLike,
  isNumbered,
  paragraphSegments,
  paragraphText,
  parseTemplateBody,
  replaceBody,
  rowCells,
  tableRows,
  sectionBreakOf,
  withSectionBreak,
  withoutNumbering,
  withoutSectionBreak,
  writeParagraph,
  type BlockInfo,
  type BodyNode,
  type CellNode,
  type LinkRelation,
  type ParagraphNode,
  type RowNode,
  type TableNode,
  type TemplateBody,
  type TextAtom,
} from "./template-blocks";
import {
  cleanText,
  comparable,
  isSafeWebUrl,
  linkDisplayText,
  toParagraphs,
  toSentences,
} from "./text";

/*
 * Fills a copy of the client's own DOCX template with a resume, following a
 * checked FillPlan: the template's tables, labels, headings, styles,
 * numbering, headers/footers and page setup stay; its sample candidate's
 * content is replaced by references resolved from ResumeContent. Nothing
 * from the plan is written into the document except resolved resume text,
 * and every string is XML-escaped by the block serialiser.
 */

export interface FillResult {
  data: Uint8Array;
  /** Template texts that must not survive in the output (sample name, replaced sample values). */
  forbiddenTexts: string[];
  warnings: string[];
}

export interface FilledBody {
  body: TemplateBody;
  forbiddenTexts: string[];
  warnings: string[];
  /** The template's sample candidate name (also replaced in headers and footers). */
  sampleName: string | null;
}

interface Context {
  entry?: ResumeEntry;
  item?: string;
  /** The repeat group's resume section ("s2"): inside a per-item group it means the current item. */
  source?: string;
  /** The block is a list item: running text becomes one line per sentence. */
  numbered: boolean;
}

interface Link {
  text: string;
  url: string;
}

const DATE_SEPARATOR = " – ";
const ADDITIONAL_HEADING = "Additional Information";
/** Labels of the candidate's own contact lines (removed, not left empty, when there is no value). */
const CONTACT_LABEL =
  /^\s*(?:location|address|city|phone|mobile|cell|e-?mail|linked ?in|website|portfolio)\s*:?\s*$/i;
/** Shorter sample texts (labels like "Yes") may legitimately appear elsewhere. */
const MIN_FORBIDDEN_CHARS = 20;

// --- reference resolution -------------------------------------------------------------

const dates = (entry: ResumeEntry) =>
  [entry.startDate, entry.endDate]
    .filter((value): value is string => Boolean(value))
    .map(cleanText)
    .join(DATE_SEPARATOR);

function descriptionLines(entry: ResumeEntry, numbered: boolean): string[] {
  return numbered ? toSentences(entry.description) : toParagraphs(entry.description);
}

/** Lines of an entry for list-like use: a title line, then its details. */
function entryLines(entry: ResumeEntry, numbered: boolean): string[] {
  const title = [entry.heading, entry.subheading, entry.location]
    .filter((value): value is string => Boolean(value))
    .map(cleanText);
  const when = dates(entry);
  const line = title.join(", ") + (when ? (title.length ? ` (${when})` : when) : "");
  return [
    ...(line ? [line] : []),
    ...descriptionLines(entry, numbered),
    ...entry.bullets.map(cleanText).filter(Boolean),
  ];
}

/** Every item of a section, for "sN" fills and per-item groups (skills, competencies, …). */
export function sectionItems(content: ResumeContent, sectionIndex: number): string[] {
  const section = content.sections[sectionIndex];
  if (!section) return [];
  return section.entries.flatMap((entry) => entryLines(entry, true));
}

function entryField(entry: ResumeEntry, field: string, ctx: Context): string[] {
  switch (field) {
    case "heading":
    case "subheading":
    case "location":
    case "startDate":
    case "endDate":
      return entry[field] ? [cleanText(entry[field])] : [];
    case "dates": {
      const when = dates(entry);
      return when ? [when] : [];
    }
    case "description":
      return descriptionLines(entry, ctx.numbered);
    case "bullets":
      return entry.bullets.map(cleanText).filter(Boolean);
    case "text":
      return [
        ...descriptionLines(entry, ctx.numbered),
        ...entry.bullets.map(cleanText).filter(Boolean),
      ];
    case "item":
      return ctx.item ? [ctx.item] : [];
    default:
      return [];
  }
}

/** Values for one reference part. Links come back with their URL for hyperlinks. */
function resolvePart(part: string, content: ResumeContent, ctx: Context): (string | Link)[] {
  // One clone per item (a skill per row): every reference to the group's own
  // section, or to the entry, shows this clone's item — never the whole list.
  if (
    ctx.item !== undefined &&
    (part.startsWith("entry.") ||
      (ctx.source !== undefined && (part === ctx.source || part.startsWith(`${ctx.source}.`))))
  ) {
    return [ctx.item];
  }
  if (ctx.entry && ctx.source !== undefined) {
    const own = new RegExp(`^${ctx.source}\\.e\\d+\\.(\\w+)$`).exec(part);
    if (own) return entryField(ctx.entry, own[1]!, ctx);
  }
  if (part === "-") return [""];
  if ((CONTACT_REFS as readonly string[]).includes(part)) {
    const field = part.slice("contact.".length);
    const { contact } = content;
    if (field === "links") {
      return contact.links.map((link) =>
        isSafeWebUrl(link.url)
          ? { text: linkDisplayText(link.url), url: link.url }
          : cleanText(link.label || link.url),
      );
    }
    const value = contact[field as "fullName" | "headline" | "email" | "phone" | "location"];
    return value ? [cleanText(value)] : [];
  }
  if (part === "summary")
    return ctx.numbered ? toSentences(content.summary) : toParagraphs(content.summary);
  const whole = /^s(\d+)$/.exec(part);
  if (whole) return sectionItems(content, Number(whole[1]));
  const direct = /^(s\d+\.e\d+)\.(\w+)$/.exec(part);
  if (direct) {
    const resolved = resolveEntryRef(content, direct[1]!);
    return resolved ? entryField(resolved.entry, direct[2]!, ctx) : [];
  }
  const inGroup = /^entry\.(\w+)$/.exec(part);
  if (inGroup && ctx.entry) return entryField(ctx.entry, inGroup[1]!, ctx);
  if (inGroup && ctx.item !== undefined) return inGroup[1] === "item" ? [ctx.item] : [];
  return [];
}

const asText = (value: string | Link) => (typeof value === "string" ? value : value.text);

/**
 * Values for a segment reference. Scalar parts joined with "+" become one
 * value separated by ", "; a part with several values (bullets, items,
 * summary paragraphs) yields one value per line.
 */
function resolveRef(ref: string | null, content: ResumeContent, ctx: Context): (string | Link)[] {
  if (ref === null) return [];
  // The same reference written twice ("s2.e0.bullets+s2.e0.bullets") shows once.
  const unique = [...new Set(refParts(ref))];
  const parts = withDateRanges(unique).map((part) => resolvePart(part, content, ctx));
  if (parts.length === 1) return parts[0]!;
  const joined = parts.flatMap((values) => values.map(asText)).filter(Boolean);
  // Contact details on one line read "email | phone".
  const separator = refParts(ref).every((part) => part.startsWith("contact.")) ? " | " : ", ";
  return joined.length ? [joined.join(separator)] : [];
}

/** A start and an end date of the same entry, side by side, read as one range ("Feb 2009 – 2015"). */
function withDateRanges(parts: string[]): string[] {
  return parts.flatMap((part) => {
    const start = /^(.*)\.startDate$/.exec(part);
    if (start && parts.includes(`${start[1]}.endDate`)) return [`${start[1]}.dates`];
    const end = /^(.*)\.endDate$/.exec(part);
    if (end && parts.includes(`${end[1]}.startDate`)) return [];
    return [part];
  });
}

// --- paragraph and cell writing -----------------------------------------------------------

function textValues(values: (string | Link)[]): string[] {
  return values.map(asText);
}

/**
 * One paragraph per value (none when there is nothing to show); a single
 * text run becomes a hyperlink when the value is a link.
 */
function paragraphsFor(template: ParagraphNode, values: (string | Link)[]): ParagraphNode[] {
  return values.map((value) => {
    const written = writeParagraph(template, [asText(value)]);
    if (typeof value !== "string") {
      const atom = written.atoms.find((a): a is TextAtom => a.kind === "text");
      if (atom) atom.href = value.url;
    }
    return written;
  });
}

/**
 * Applies a fill to a paragraph: one value per segment. When the paragraph
 * has a single segment and the reference yields several lines (bullets,
 * summary paragraphs), the paragraph is repeated once per line.
 */
function fillParagraph(
  paragraph: ParagraphNode,
  fill: Fill,
  content: ResumeContent,
  ctx: Context,
): ParagraphNode[] {
  const context = { ...ctx, numbered: isNumbered(paragraph) };
  const segments = paragraphSegments(paragraph);
  // More values than the line has parts: the extra ones join the last part
  // ("Degree, School, Feb 2009 – 2015"), never run together.
  let refs = fill.refs;
  const parts = Math.max(segments.length, 1);
  if (refs.length > parts) {
    const tail = refs.slice(parts - 1).filter((ref): ref is string => ref !== null && ref !== "-");
    refs = [...refs.slice(0, parts - 1), tail.length ? tail.join("+") : null];
  }
  if (segments.length <= 1 && refs.length === 1) {
    const values = resolveRef(refs[0]!, content, context);
    const label = isNumbered(paragraph) ? null : fieldLabel(segments[0]?.text);
    if (label && values.length === 1 && typeof values[0] === "string") {
      return paragraphsFor(paragraph, [withLabel(label, values[0])]);
    }
    return paragraphsFor(paragraph, values);
  }
  const values = refs.map((ref, index) => {
    if (ref === null) return null;
    const value = textValues(resolveRef(ref, content, context)).join("; ");
    const label = isNumbered(paragraph) ? null : fieldLabel(segments[index]?.text);
    return label && value ? withLabel(label, value) : value;
  });
  return [writeParagraph(paragraph, values)];
}

/** The form-field label at the start of a line ("Location: "), if it is one. */
function fieldLabel(text: string | undefined): string | null {
  const label = inlineLabel(text);
  return label && isFieldLabel(label) ? label : null;
}

/** A labelled sample line with its value removed ("Pay Rate: $36/hr" → "Pay Rate:"). */
function labelOnly(paragraph: ParagraphNode, label: string): ParagraphNode {
  const values = paragraphSegments(paragraph).map((_segment, index) =>
    index === 0 ? label.trimEnd() : "",
  );
  return writeParagraph(paragraph, values.length ? values : [label.trimEnd()]);
}

const withLabel = (label: string, value: string) =>
  value.toLowerCase().startsWith(label.trim().toLowerCase()) ? value : `${label}${value}`;

function fillCell(cell: CellNode, fill: Fill, content: ResumeContent, ctx: Context): CellNode {
  const paragraphs = cellParagraphs(cell);
  const first = paragraphs[0];
  if (!first) return cell;
  const filled = fillParagraph(first, fill, content, ctx);
  // The cell's other paragraphs were the sample's continuation.
  const others = cell.children.filter((child) => child.kind !== "paragraph");
  return { ...cell, children: [...(filled.length ? filled : [emptyParagraph(first)]), ...others] };
}

function clearCell(cell: CellNode): CellNode {
  const first = cellParagraphs(cell)[0];
  return { ...cell, children: first ? [emptyParagraph(first)] : [] };
}

/** Entry fields a group's fills show ("text" covers description and bullets, "dates" both dates). */
function groupFields(group: FillGroup, fills: Map<string, Fill>): Set<string> {
  const fields = new Set<string>();
  const ids = group.blocks.length ? group.blocks : group.rows;
  for (const [block, fill] of fills) {
    const inGroup = ids.some((id) => block === id || block.startsWith(`${id}.`));
    if (!inGroup) continue;
    // "entry.<field>", or a direct reference to the group's own section ("s2.e0.heading").
    const own = new RegExp(`^${group.source}\\.e\\d+\\.(\\w+)$`);
    for (const ref of fill.refs) {
      for (const part of refParts(ref ?? "")) {
        const match = /^entry\.(\w+)$/.exec(part) ?? own.exec(part);
        if (match) fields.add(match[1]!);
      }
    }
  }
  if (fields.has("text")) fields.add("description").add("bullets");
  if (fields.has("dates")) fields.add("startDate").add("endDate");
  // Either date shown counts as the dates shown (e.g. a "Completed" column with the end year).
  if (fields.has("startDate") || fields.has("endDate")) fields.add("dates");
  return fields;
}

/** Scalar facts of an entry the group has no segment for (shown after the first filled value). */
function leftoverScalars(entry: ResumeEntry, shown: Set<string>): string[] {
  const out: string[] = [];
  for (const field of ["heading", "subheading", "location"] as const) {
    if (entry[field] && !shown.has(field)) out.push(cleanText(entry[field]));
  }
  if (!shown.has("dates")) {
    const parts = [
      !shown.has("startDate") ? entry.startDate : undefined,
      !shown.has("endDate") ? entry.endDate : undefined,
    ].filter(Boolean) as string[];
    if (parts.length) out.push(parts.map(cleanText).join(DATE_SEPARATOR));
  }
  return out;
}

function leftoverLines(entry: ResumeEntry, shown: Set<string>, numbered: boolean): string[] {
  return [
    ...(shown.has("description") ? [] : descriptionLines(entry, numbered)),
    ...(shown.has("bullets") ? [] : entry.bullets.map(cleanText).filter(Boolean)),
  ];
}

/** Appends ", value" to the first text run of a paragraph (or writes it when empty). */
function appendToParagraph(paragraph: ParagraphNode, extra: string[]): ParagraphNode {
  if (extra.length === 0) return paragraph;
  const first = paragraph.atoms.find(
    (atom): atom is TextAtom => atom.kind === "text" && atom.text.trim().length > 0,
  );
  if (!first) return writeParagraph(paragraph, [extra.join(", ")]);
  return {
    ...paragraph,
    atoms: paragraph.atoms.map((atom) =>
      atom === first ? { ...atom, text: `${atom.text.trimEnd()}, ${extra.join(", ")}` } : atom,
    ),
  };
}

class Filler {
  readonly warnings: string[] = [];
  readonly forbidden: string[] = [];
  sampleName: string | null = null;
  private readonly fills = new Map<string, Fill>();
  private readonly clears: Set<string>;
  private readonly groupsByFirst = new Map<string, FillGroup>();
  private readonly grouped = new Set<string>();

  constructor(
    private readonly plan: FillPlan,
    private readonly content: ResumeContent,
    private readonly body: TemplateBody,
    /** Resume texts the filled document would otherwise lack: listed at the end. */
    private readonly extraLines: readonly string[] = [],
  ) {
    for (const fill of plan.fills) this.fills.set(fill.block, fill);
    this.clears = new Set(plan.clears);
    for (const group of plan.groups) {
      const ids = group.blocks.length ? group.blocks : group.rows;
      this.groupsByFirst.set(ids[0]!, group);
      for (const id of ids) this.grouped.add(id);
    }
  }

  private forbid(text: string) {
    // Labels may reappear, and so may the heading added for content without a place.
    if (
      isLabelLike(text, false) ||
      comparable(text).toLowerCase() === ADDITIONAL_HEADING.toLowerCase()
    )
      return;
    const normalised = comparable(text);
    if (normalised.length >= MIN_FORBIDDEN_CHARS) this.forbidden.push(normalised);
  }

  private noteSample(id: string, text: string) {
    const fill = this.fills.get(id);
    if (fill?.refs.includes("contact.fullName") && !this.sampleName) {
      const index = fill.refs.indexOf("contact.fullName");
      const segment = text.split("\t").filter((part) => part.trim())[index] ?? text;
      const name = segment.trim();
      if (name.length >= 3) this.sampleName = name;
    }
    this.forbid(text);
  }

  /** Entries (or items) a group repeats for. */
  private repetitions(group: FillGroup): Context[] {
    const index = Number(group.source.slice(1));
    if (group.per === "item") {
      return sectionItems(this.content, index).map((item) => ({
        item,
        numbered: false,
        source: group.source,
      }));
    }
    const section = this.content.sections[index];
    return (section?.entries ?? [])
      .filter((entry) => entryLines(entry, false).length > 0)
      .map((entry) => ({ entry, numbered: false, source: group.source }));
  }

  fill(): TemplateBody {
    const nodes: BodyNode[] = [];
    // Section breaks (a switch to two columns, a new page setup) end the
    // paragraph that carries them. That paragraph may be cleared, filled or
    // repeated, so each break is taken off it and put back once, after
    // whatever the paragraph became.
    const sectionBreaks = new Map<string, string>();
    const source = this.body.nodes.map((node) => {
      const sectPr = node.kind === "paragraph" ? sectionBreakOf(node) : null;
      if (node.kind !== "paragraph" || !sectPr) return node;
      sectionBreaks.set(node.id, sectPr);
      return withoutSectionBreak(node);
    });
    const endSections = (from: number, to: number) => {
      for (let at = from; at <= to; at++) {
        const node = source[at]!;
        const sectPr = node.kind === "paragraph" ? sectionBreaks.get(node.id) : undefined;
        if (!sectPr) continue;
        const last = nodes.at(-1);
        if (last?.kind === "paragraph" && !sectionBreakOf(last)) {
          nodes[nodes.length - 1] = withSectionBreak(last, sectPr);
        } else {
          nodes.push(
            withSectionBreak(
              { kind: "paragraph", id: `sect${at}`, attrs: "", pPr: "", atoms: [] },
              sectPr,
            ),
          );
        }
      }
    };
    for (let index = 0; index < source.length; index++) {
      const from = index;
      index = this.fillNode(source, index, nodes);
      endSections(from, index);
    }
    const width = textWidthOf(this.body.sectPr);
    const aligned = nodes.map((node) =>
      node.kind === "paragraph" ? alignTabbedDates(node, width) : node,
    );
    const body = { ...this.body, nodes: tidyBlankLines(aligned, source) };
    this.appendAdditional(body);
    if (this.plan.insertName) {
      // In the template's heading font and size, bold, without list numbering.
      const model = sectionHeadingModel(
        this.body.nodes
          .filter((node): node is ParagraphNode => node.kind === "paragraph")
          .map(withoutSectionBreak),
      );
      const name = cleanText(this.content.contact.fullName);
      const rPr = model?.atoms.find((atom): atom is TextAtom => atom.kind === "text")?.rPr ?? "";
      body.nodes.unshift({
        kind: "paragraph",
        id: "name",
        attrs: "",
        pPr: model ? withoutNumbering(model.pPr) : "",
        atoms: [{ kind: "text", rPr: withBold(rPr), text: name }],
      });
    }
    return body;
  }

  /**
   * Fills one body node into `nodes` — or a whole repeat group starting at
   * it; returns the index of the last source node used.
   */
  private fillNode(source: BodyNode[], index: number, nodes: BodyNode[]): number {
    const node = source[index]!;
    if (node.kind === "other") {
      nodes.push(node);
      return index;
    }
    if (node.kind === "table") {
      nodes.push(this.fillTable(node));
      return index;
    }
    const group = this.groupsByFirst.get(node.id);
    if (group) {
      // The group's paragraphs, in order; verbatim nodes between them (bookmarks) are dropped.
      const wanted = new Set(group.blocks);
      const run: ParagraphNode[] = [];
      let end = index;
      for (; end < source.length && wanted.size > 0; end++) {
        const candidate = source[end]!;
        if (candidate.kind === "other") continue;
        if (candidate.kind !== "paragraph" || !wanted.has(candidate.id)) break;
        wanted.delete(candidate.id);
        run.push(candidate);
      }
      nodes.push(...this.cloneParagraphGroup(group, run));
      return end - 1;
    }
    if (this.clears.has(node.id)) {
      this.forbid(paragraphText(node));
      // A form field's label stays ("Pay Rate:"); sample content goes
      // entirely — and so does a contact line the candidate has no value for
      // (an empty "Location:" under the name).
      const label = isNumbered(node) ? null : fieldLabel(paragraphText(node));
      if (label && !CONTACT_LABEL.test(label)) nodes.push(labelOnly(node, label));
      return index;
    }
    const fill = this.fills.get(node.id);
    if (fill) {
      this.noteSample(node.id, paragraphText(node));
      nodes.push(
        ...fillParagraph(styledLike(node, source, index), fill, this.content, { numbered: false }),
      );
      return index;
    }
    nodes.push(node);
    return index;
  }

  private cloneParagraphGroup(group: FillGroup, run: ParagraphNode[]): ParagraphNode[] {
    for (const paragraph of run) {
      if (this.fills.has(paragraph.id) || this.clears.has(paragraph.id)) {
        this.forbid(paragraphText(paragraph));
      }
    }
    const shown = groupFields(group, this.fills);
    const out: ParagraphNode[] = [];
    const first = run.find((p) => paragraphText(p).trim().length > 0);
    const separated =
      run.length > 1 && isBlankLine(run.at(-1)!)
        ? true
        : first !== undefined && spaceBefore(first.pPr) >= MIN_ENTRY_SPACE_TWIPS;
    for (const ctx of this.repetitions(group)) {
      let firstFilled = -1;
      const clone: ParagraphNode[] = [];
      for (const paragraph of run) {
        if (this.clears.has(paragraph.id)) continue;
        const fill = this.fills.get(paragraph.id);
        if (!fill) {
          clone.push(paragraph);
          continue;
        }
        const filled = fillParagraph(paragraph, fill, this.content, ctx);
        if (firstFilled === -1 && filled.length > 0) firstFilled = clone.length;
        clone.push(...filled);
      }
      if (ctx.entry) {
        const scalars = leftoverScalars(ctx.entry, shown);
        if (scalars.length && firstFilled >= 0)
          clone[firstFilled] = appendToParagraph(clone[firstFilled]!, scalars);
        const lines = leftoverLines(ctx.entry, shown, true);
        if (lines.length) {
          const model = [...run].reverse().find((p) => isNumbered(p)) ?? run.at(-1)!;
          const lastFilled = clone.findLastIndex((p) => paragraphText(p).trim().length > 0);
          clone.splice(lastFilled + 1, 0, ...paragraphsFor(model, lines));
        }
        if (scalars.length || lines.length) this.noteLeftovers();
      }
      // A template that puts nothing between its sample entries (no blank
      // line, no space above the first line) would run the real entries
      // together: a small gap goes above every entry after the first.
      if (out.length > 0 && !separated) {
        const at = clone.findIndex((p) => paragraphText(p).trim().length > 0);
        if (at >= 0) clone[at] = withSpaceBefore(clone[at]!, ENTRY_GAP_TWIPS);
      }
      out.push(...clone);
    }
    return out;
  }

  private leftoversNoted = false;
  private noteLeftovers() {
    if (this.leftoversNoted) return;
    this.leftoversNoted = true;
    this.warnings.push(
      "Some details of the experience/education entries had no place in the template's entry layout and were added to the nearest line.",
    );
  }

  private fillTable(table: TableNode): TableNode {
    const rows = tableRows(table);
    const children: TableNode["children"] = [];
    for (let index = 0; index < table.children.length; index++) {
      const child = table.children[index]!;
      if (child.kind !== "row") {
        children.push(child);
        continue;
      }
      const group = this.groupsByFirst.get(child.id);
      if (group) {
        const start = rows.indexOf(child);
        const run = rows.slice(start, start + group.rows.length);
        children.push(...this.cloneRowGroup(group, run));
        index += group.rows.length - 1;
        continue;
      }
      if (this.clears.has(child.id)) {
        for (const cell of rowCells(child)) this.forbid(cellText(cell));
        continue;
      }
      children.push(this.fillRow(child, { numbered: false }));
    }
    return { ...table, children };
  }

  private fillRow(row: RowNode, ctx: Context): RowNode {
    return {
      ...row,
      children: row.children.map((child) => {
        if (child.kind !== "cell") return child;
        if (this.clears.has(child.id)) {
          this.forbid(cellText(child));
          return clearCell(child);
        }
        const fill = this.fills.get(child.id);
        if (!fill || child.opaque) return child;
        this.noteSample(child.id, cellText(child));
        return fillCell(child, fill, this.content, ctx);
      }),
    };
  }

  private cloneRowGroup(group: FillGroup, run: RowNode[]): RowNode[] {
    for (const row of run) {
      for (const cell of rowCells(row)) {
        if (this.fills.has(cell.id) || this.clears.has(cell.id)) this.forbid(cellText(cell));
      }
    }
    const shown = groupFields(group, this.fills);
    const out: RowNode[] = [];
    for (const ctx of this.repetitions(group)) {
      const clone = run.map((row) => this.fillRow(row, ctx));
      if (ctx.entry) {
        const scalars = leftoverScalars(ctx.entry, shown);
        const lines = leftoverLines(ctx.entry, shown, false);
        if (scalars.length || lines.length) {
          const cells = clone.flatMap(rowCells).filter((cell) => this.fills.has(cell.id));
          const first = cells[0];
          const last = cells.at(-1);
          if (first) {
            const paragraphs = cellParagraphs(first);
            if (paragraphs[0]) {
              const amended = appendToParagraph(paragraphs[0], scalars);
              first.children = [amended, ...first.children.slice(1)];
            }
          }
          if (last && lines.length) {
            const model = cellParagraphs(last).at(-1);
            if (model) last.children.push(...paragraphsFor(model, lines));
          }
          this.noteLeftovers();
        }
      }
      out.push(...clone);
    }
    return out;
  }

  // --- content the template has no place for ---

  private additionalItems(): { label: string; lines: string[] }[] {
    const items: { label: string; lines: string[] }[] = [];
    for (const ref of this.plan.additional) {
      if (ref === "summary") {
        items.push({ label: "Summary", lines: toSentences(this.content.summary) });
        continue;
      }
      const match = /^(s(\d+)\.e\d+)(?:\.(\w+))?$/.exec(ref);
      if (!match) continue;
      const resolved = resolveEntryRef(this.content, match[1]!);
      if (!resolved) continue;
      const label = this.content.sections[Number(match[2])]!.title;
      const lines = match[3]
        ? entryField(resolved.entry, match[3], { numbered: true })
        : entryLines(resolved.entry, true);
      if (lines.length) items.push({ label, lines });
    }
    return items;
  }

  private appendAdditional(body: TemplateBody) {
    const items = this.additionalItems();
    if (items.length === 0 && this.extraLines.length === 0) return;
    // Models never carry a section break (that would start a new section).
    const originals = this.body.nodes
      .filter((node): node is ParagraphNode => node.kind === "paragraph")
      .map(withoutSectionBreak);
    const headingModel = sectionHeadingModel(originals);
    // A plain (not bold) list item: added bullets are body text.
    const bulletModel =
      originals.find((p) => isNumbered(p) && paragraphText(p).trim() && !isBold(p)) ??
      originals.find((p) => isNumbered(p) && paragraphText(p).trim());
    // Left-aligned body text (not the centered contact line under the name).
    const plain = (p: ParagraphNode) => {
      const info = describeParagraph(p);
      return (
        !info.numbered &&
        !info.empty &&
        !info.bold &&
        info.segments.length === 1 &&
        !centered(info.align)
      );
    };
    // Preferably not indented either (an indented degree line under a school).
    const indented = (p: ParagraphNode) => /<w:ind\b[^>]*w:(?:left|start)="[1-9]/.test(p.pPr);
    const plainModel =
      originals.find((p) => plain(p) && !indented(p)) ??
      originals.find(plain) ??
      originals.find(
        (p) => !isNumbered(p) && !isHeadingLike(describeParagraph(p)) && paragraphText(p).trim(),
      );
    // One line of text in the model's style: every tab segment is overwritten and the tabs go.
    const paragraph = (
      model: ParagraphNode | undefined,
      text: string,
      bold = false,
    ): ParagraphNode => {
      if (model) {
        const blanks = paragraphSegments(model)
          .slice(1)
          .map(() => "");
        const written = writeParagraph({ ...model, id: "extra" }, [text, ...blanks]);
        return { ...written, atoms: written.atoms.filter((atom) => atom.kind !== "tab") };
      }
      return {
        kind: "paragraph",
        id: "extra",
        attrs: "",
        pPr: "",
        atoms: [{ kind: "text", rPr: bold ? "<w:rPr><w:b/></w:rPr>" : "", text }],
      };
    };
    const bullet = (text: string) => {
      if (!bulletModel) return paragraph(plainModel, `• ${text}`);
      const written = paragraph(bulletModel, text);
      return { ...written, atoms: written.atoms.map(notBold) };
    };
    const label = (text: string) => {
      const base = paragraph(plainModel, text, true);
      const atoms = base.atoms.map((atom) =>
        atom.kind === "text" ? { ...atom, rPr: withBold(atom.rPr) } : atom,
      );
      // At the left margin, like the heading above it.
      return { ...base, pPr: base.pPr.replace(/<w:ind\b[^>]*\/>/, ""), atoms };
    };

    // A template that leaves a blank line before its section headings gets
    // one before this heading too (unless the body already ends blank).
    const spacer = originals.find((p, index) => {
      const next = originals[index + 1];
      return (
        p.atoms.every((atom) => atom.kind !== "other") &&
        !paragraphText(p).trim() &&
        next !== undefined &&
        isHeadingLike(describeParagraph(next))
      );
    });
    const last = body.nodes.at(-1);
    if (spacer && !(last?.kind === "paragraph" && !paragraphText(last).trim())) {
      body.nodes.push({ ...spacer, id: "extra", atoms: [] });
    }
    body.nodes.push(paragraph(headingModel, ADDITIONAL_HEADING, true));
    // Items from the same section share one label.
    let previous: string | null = null;
    for (const item of items) {
      if (item.label !== previous) body.nodes.push(label(item.label));
      previous = item.label;
      for (const line of item.lines) body.nodes.push(bullet(line));
    }
    // Details the plan left out (found by the final check), one bullet each.
    for (const line of this.extraLines) body.nodes.push(bullet(line));
  }
}

/**
 * An empty paragraph with no run style of its own would show new text in
 * the document default font; it takes the font of the text above it.
 */
function styledLike(paragraph: ParagraphNode, source: BodyNode[], index: number): ParagraphNode {
  if (paragraphText(paragraph).trim() || /<w:rPr>/.test(paragraph.pPr)) return paragraph;
  if (paragraph.atoms.some((atom) => atom.kind === "text" && atom.rPr)) return paragraph;
  for (let at = index - 1; at >= 0; at--) {
    const node = source[at]!;
    if (node.kind !== "paragraph") continue;
    const run = node.atoms.find(
      (atom): atom is TextAtom => atom.kind === "text" && atom.text.trim().length > 0,
    );
    if (!run) continue;
    // Font and size only: not the bold of a heading above.
    const rPr = run.rPr.replace(/<w:b(?:Cs)?(?:\s[^>]*)?\/>/g, "");
    const pPr = paragraph.pPr
      ? paragraph.pPr.replace("</w:pPr>", `${rPr}</w:pPr>`)
      : `<w:pPr>${rPr}</w:pPr>`;
    return { ...paragraph, pPr };
  }
  return paragraph;
}

const ENTRY_GAP_TWIPS = 160; // 8 pt
const MIN_ENTRY_SPACE_TWIPS = 80; // a template with at least 4 pt above its entries is left alone

/** The space above a paragraph (twips) set directly on it; 0 when none. */
function spaceBefore(pPr: string): number {
  const spacing = /<w:spacing\b[^>]*\/>/.exec(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""))?.[0];
  return Number(/\bw:before="(\d+)"/.exec(spacing ?? "")?.[1] ?? 0);
}

/** The paragraph with the given space above it (twips). */
function withSpaceBefore(paragraph: ParagraphNode, twips: number): ParagraphNode {
  const pPr = paragraph.pPr || "<w:pPr></w:pPr>";
  const bare = pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "");
  const existing = /<w:spacing\b[^>]*\/>/.exec(bare)?.[0];
  if (existing) {
    const next = /\bw:before="/.test(existing)
      ? existing.replace(/\bw:before="\d+"/, `w:before="${twips}"`)
      : existing.replace("<w:spacing", `<w:spacing w:before="${twips}"`);
    return { ...paragraph, pPr: pPr.replace(existing, next) };
  }
  const spacing = `<w:spacing w:before="${twips}"/>`;
  const at = pPr.search(PPR_AFTER_SPACING);
  return {
    ...paragraph,
    pPr:
      at === -1
        ? pPr.replace("</w:pPr>", `${spacing}</w:pPr>`)
        : `${pPr.slice(0, at)}${spacing}${pPr.slice(at)}`,
  };
}
const PPR_AFTER_SPACING =
  /<w:(?:ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;

const centered = (align: string | undefined) => align === "center" || align === "right";

const withoutSectionBreakNode = (node: BodyNode): BodyNode =>
  node.kind === "paragraph" ? withoutSectionBreak(node) : node;

const DATE_LIKE = /\b(?:19|20)\d{2}\b|\b(?:present|current|till date|to date)\b/i;
const PPR_AFTER_TABS =
  /<w:(?:suppressAutoHyphens|kinsoku|wordWrap|overflowPunct|topLinePunct|autoSpaceDE|autoSpaceDN|bidi|adjustRightInd|snapToGrid|spacing|ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;

/** Width of the text area (page width minus side margins), in twips. */
function textWidthOf(sectPr: string): number | null {
  const attr = (tag: string, name: string) =>
    Number(new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="(\\d+)"`).exec(sectPr)?.[1]);
  const page = attr("pgSz", "w");
  const left = attr("pgMar", "left");
  const right = attr("pgMar", "right");
  const width = page - left - right - (attr("pgMar", "gutter") || 0);
  return Number.isFinite(width) && width > 2000 ? width : null;
}

/**
 * Templates line dates up with a run of tab characters ("Employer⇥⇥⇥⇥⇥ 2021").
 * That only lands in the right place for the sample's employer name: a longer
 * name uses up more tabs and the date moves away from the right edge. Such a
 * line gets one tab and a right-aligned tab stop at the margin instead.
 */
function alignTabbedDates(paragraph: ParagraphNode, width: number | null): ParagraphNode {
  if (!width || /<w:tab\s/.test(paragraph.pPr)) return paragraph;
  const segments = paragraphSegments(paragraph);
  if (segments.length < 2) return paragraph;
  const last = segments.at(-1)!;
  if (last.text.length > 40 || !DATE_LIKE.test(last.text)) return paragraph;
  const from = segments.at(-2)!.to;
  const tabs = paragraph.atoms.slice(from, last.from).filter((atom) => atom.kind === "tab");
  if (tabs.length < 2) return paragraph;
  const gap = paragraph.atoms.slice(from, last.from);
  if (gap.some((atom) => atom.kind !== "tab" && !(atom.kind === "text" && !atom.text.trim())))
    return paragraph;
  const atoms = [...paragraph.atoms.slice(0, from), tabs[0]!, ...paragraph.atoms.slice(last.from)];
  const stop = `<w:tabs><w:tab w:val="right" w:pos="${width}"/></w:tabs>`;
  const pPr = !paragraph.pPr
    ? `<w:pPr>${stop}</w:pPr>`
    : paragraph.pPr === "<w:pPr/>"
      ? `<w:pPr>${stop}</w:pPr>`
      : (() => {
          const at = paragraph.pPr.search(PPR_AFTER_TABS);
          return at === -1
            ? paragraph.pPr.replace("</w:pPr>", `${stop}</w:pPr>`)
            : `${paragraph.pPr.slice(0, at)}${stop}${paragraph.pPr.slice(at)}`;
        })();
  return { ...paragraph, pPr, atoms };
}

/** A blank line: no text, nothing drawn, no section break. */
function isBlankLine(node: BodyNode): boolean {
  return (
    node.kind === "paragraph" &&
    !sectionBreakOf(node) &&
    node.atoms.every((atom) => atom.kind !== "other") &&
    !paragraphText(node).trim()
  );
}

/**
 * Removing sample entries leaves their blank separators behind: runs of
 * blank lines are cut to the longest gap the template itself has (at least
 * one), and blank lines at the very end (which can spill onto an empty
 * last page) go.
 */
function tidyBlankLines(nodes: BodyNode[], template: BodyNode[]): BodyNode[] {
  let longest = 1;
  let run = 0;
  for (const node of template) {
    if (isBlankLine(node)) run++;
    else {
      longest = Math.max(longest, run);
      run = 0;
    }
  }
  // A heading the template sets off with a blank line keeps it, even when
  // that blank line went with the sample entries above it.
  const blankBefore = new Map<string, BodyNode>();
  template.forEach((node, index) => {
    const previous = template[index - 1];
    if (node.kind !== "paragraph" || !previous || !isBlankLine(previous)) return;
    if (isHeadingLike(describeParagraph(node))) blankBefore.set(node.id, previous);
  });
  const out: BodyNode[] = [];
  run = 0;
  for (const node of nodes) {
    const blank = node.kind === "paragraph" ? blankBefore.get(node.id) : undefined;
    const last = out.at(-1);
    // (An empty paragraph that only ends a section shows as a blank line too.)
    const lastBlank = last && (isBlankLine(last) || isBlankLine(withoutSectionBreakNode(last)));
    if (blank && last && !lastBlank) out.push(blank);
    if (isBlankLine(node)) {
      if (++run > longest) continue;
    } else if (isBlankLine(withoutSectionBreakNode(node))) {
      run++; // shows as a blank line, but must stay (it ends a section)
    } else run = 0;
    out.push(node);
  }
  while (out.length > 1 && isBlankLine(out.at(-1)!)) out.pop();
  return out;
}

/**
 * A section heading of the template ("Professional Experience") to style
 * added headings like — not its first line, which is usually the name.
 */
function sectionHeadingModel(paragraphs: ParagraphNode[]): ParagraphNode | undefined {
  const first = paragraphs.find((p) => paragraphText(p).trim());
  const headings = paragraphs.filter((p) => p !== first && isHeadingLike(describeParagraph(p)));
  const named = headings.filter((p) => SECTION_HEADING.test(paragraphText(p)));
  return (
    named.find((p) => !centered(describeParagraph(p).align)) ??
    named[0] ??
    headings[0] ??
    (first && isHeadingLike(describeParagraph(first)) ? first : undefined)
  );
}

const SECTION_HEADING =
  /^\s*(?:professional |work |employment |career )?(?:summary|experience|education|skills|history|profile|certifications?|languages|projects|competencies|qualifications)\b/i;

/** Pure part of the fill (no ZIP): the body with the plan applied. */
export function fillTemplateBody(
  body: TemplateBody,
  plan: FillPlan,
  content: ResumeContent,
  extraLines: readonly string[] = [],
): FilledBody {
  const filler = new Filler(plan, content, body, extraLines);
  const filled = filler.fill();
  return {
    body: filled,
    forbiddenTexts: [...new Set(filler.forbidden)],
    warnings: filler.warnings,
    sampleName: filler.sampleName,
  };
}

const HYPERLINK_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Hyperlink relationships: the template's own external links are dropped
 * (they belonged to the sample candidate) and the resume's links are added.
 */
function rewriteRelationships(rels: string, links: Map<string, string>): string {
  let out = rels.replace(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g, (relationship) =>
    relationship.includes(HYPERLINK_TYPE) ? "" : relationship,
  );
  const added = [...links]
    .map(
      ([url, id]) =>
        `<Relationship Id="${escapeAttr(id)}" Type="${HYPERLINK_TYPE}" Target="${escapeAttr(url)}" TargetMode="External"/>`,
    )
    .join("");
  out = out.replace("</Relationships>", `${added}</Relationships>`);
  return out;
}

const DEFAULT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

/** Replaces the sample candidate's name wherever it appears inside text runs of a part. */
function replaceSampleName(xml: string, sampleName: string, name: string): string {
  const needle = sampleName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const replacement = escapeAttr(name).replace(/&quot;/g, '"');
  return xml.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, (run) =>
    run.split(needle).join(replacement),
  );
}

/** The template's addressable blocks (for the AI and the plan checks). Read-only. */
export async function readTemplateBlocks(templateBytes: Uint8Array): Promise<BlockInfo[]> {
  await assertSafeDocxPackage(templateBytes);
  const zip = await JSZip.loadAsync(templateBytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("template has no word/document.xml");
  return describeBlocks(parseTemplateBody(documentXml));
}

/** Fills the template package. The input bytes are never modified. */
export async function fillDocxTemplate(
  templateBytes: Uint8Array,
  plan: FillPlan,
  content: ResumeContent,
  extraLines: readonly string[] = [],
): Promise<FillResult> {
  await assertSafeDocxPackage(templateBytes);
  const zip = await JSZip.loadAsync(templateBytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("template has no word/document.xml");

  const body = parseTemplateBody(documentXml);
  const filled = fillTemplateBody(body, plan, content, extraLines);

  const links = new Map<string, string>();
  const link: LinkRelation = (url) => {
    let id = links.get(url);
    if (!id) {
      id = `rIdFill${links.size + 1}`;
      links.set(url, id);
    }
    return id;
  };
  let newDocument = replaceBody(documentXml, filled.body, link);

  const name = cleanText(content.contact.fullName);
  const parts = Object.keys(zip.files).filter((file) =>
    /^word\/(?:header|footer)\d*\.xml$/.test(file),
  );
  if (filled.sampleName) {
    newDocument = replaceSampleName(newDocument, filled.sampleName, name);
    for (const part of parts) {
      const xml = await zip.file(part)!.async("string");
      zip.file(part, replaceSampleName(xml, filled.sampleName, name));
    }
  }
  zip.file("word/document.xml", newDocument);
  const rels = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? DEFAULT_RELS;
  zip.file("word/_rels/document.xml.rels", rewriteRelationships(rels, links));

  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return {
    data,
    forbiddenTexts: [
      ...(filled.sampleName ? [comparable(filled.sampleName)] : []),
      ...filled.forbiddenTexts,
    ],
    warnings: filled.warnings,
  };
}

/** Run properties with bold switched on (kept in schema order: after rStyle/rFonts). */
/** The atom with bold switched off (text runs only). */
function notBold<T extends { kind: string; rPr?: string }>(atom: T): T {
  if (atom.kind !== "text" || !atom.rPr) return atom;
  return { ...atom, rPr: atom.rPr.replace(/<w:b(?:Cs)?(?:\s[^>]*)?\/>/g, "") };
}

function withBold(rPr: string): string {
  if (!rPr) return "<w:rPr><w:b/></w:rPr>";
  if (/<w:b\b(?![^>]*w:val="(?:0|false)")/.test(rPr)) return rPr;
  const cleaned = rPr.replace(/<w:b\b[^>]*\/>/g, "");
  const anchor = /<w:rFonts\b[^>]*\/>|<w:rStyle\b[^>]*\/>/g;
  let last: RegExpExecArray | null = null;
  for (let match = anchor.exec(cleaned); match; match = anchor.exec(cleaned)) last = match;
  if (last) {
    const at = last.index + last[0].length;
    return `${cleaned.slice(0, at)}<w:b/>${cleaned.slice(at)}`;
  }
  return cleaned.replace("<w:rPr>", "<w:rPr><w:b/>");
}
