import type { BlockInfo, ParagraphInfo, RowInfo } from "@/lib/documents/docx/template-blocks";
import { inlineLabel, isHeadingLike, isLabelLike } from "@/lib/documents/docx/template-blocks";
import type { ResumeContent } from "@/lib/documents/resume-content";

import {
  entryRef,
  hasEntryContent,
  planKindForSection,
  presentContactFields,
  resolveEntryRef,
} from "./content-refs";
import {
  CONTACT_REFS,
  refParts,
  type AIFillPlan,
  type Fill,
  type FillGroup,
  type FillPlan,
} from "./fill-plan";
import type { PlanSource } from "./finalize-plan";
import type { ContactField } from "./plan";

/**
 * Deterministic checks and fixes applied to a validated AI FillPlan:
 *
 * 1. blocks: fills, clears, keeps and groups must name blocks that exist;
 *    cells with nested content cannot be filled; one fill per block;
 * 2. groups: consecutive body paragraphs, or consecutive rows of one table;
 *    one group per resume section, one group per block; "entry.*"
 *    references only inside groups;
 * 3. completeness: every summary/entry is shown by a group, a direct fill or
 *    — if the template has no block for it — the "Additional Information"
 *    part added at the end (reported in `warnings`);
 * 4. contact details only where the template has them; the name always
 *    (inserted at the top when no block shows it);
 * 5. leftover sample entries: blocks that follow a repeat group and look
 *    like more sample entries (bullets, dated lines, rows of the same shape)
 *    are removed, so the template's sample person never survives.
 *
 * `issues` describe what was wrong with the AI plan (used for one correction
 * request; they contain block ids and references only, never resume text).
 */

export interface FinalizeFillResult {
  plan: FillPlan;
  issues: string[];
  warnings: string[];
}

interface ParagraphAt {
  info: ParagraphInfo;
  index: number;
}

interface RowAt {
  tableId: string;
  index: number;
  span: number;
  cellIds: string[];
}

/** Contact fields named by a field label ("Current Location:", "Candidate Name:"). */
const LABEL_FIELDS: [RegExp, string][] = [
  [/\b(?:full name|name|candidate)\b/i, "contact.fullName"],
  [/\b(?:location|address|city|residence|based)\b/i, "contact.location"],
  [/\b(?:phone|mobile|cell|telephone|contact number)\b/i, "contact.phone"],
  [/\be-?mail\b/i, "contact.email"],
  [/\b(?:linkedin|link|url|website|portfolio)\b/i, "contact.links"],
  [/\b(?:title|position|role|headline|designation)\b/i, "contact.headline"],
];

/**
 * Does a labelled field fit the references filled into it? Contact details
 * and the summary need a label naming them; whole sections a label of their
 * kind; an entry's fields only must not land under another section's label.
 */
function labelFits(
  label: string,
  refs: (string | null)[],
  group: FillGroup | undefined,
  content: ResumeContent,
): boolean {
  const field = LABEL_FIELDS.find(([pattern]) => pattern.test(label))?.[1];
  const labelKind = kindOfHeading(label);
  return refs
    .flatMap((ref) => (ref ? refParts(ref) : []))
    .every((part) => {
      if (part.startsWith("contact.")) return field === part;
      if (part === "summary") return labelKind === "summary";
      const section = part.startsWith("entry.") ? group?.source : /^(s\d+)/.exec(part)?.[1];
      if (!section) return false;
      const sectionKind = planKindForSection(content, Number(section.slice(1)));
      const whole = /^s\d+$/.test(part);
      if (!labelKind) return !whole;
      return compatibleKinds(labelKind, sectionKind);
    });
}

const HEADING_KINDS: [RegExp, string][] = [
  [/\b(?:experience|employment|work history|career|professional background)\b/i, "experience"],
  [/\b(?:education|academic|qualifications?|degrees?)\b/i, "education"],
  [/\blanguages?\b/i, "languages"],
  [/\b(?:certifications?|licen[cs]es?|credentials)\b/i, "certifications"],
  [/\bprojects?\b/i, "projects"],
  [/\b(?:awards?|honou?rs|achievements)\b/i, "awards"],
  // Tools and technologies lists hold skills only (not languages or certificates).
  [/^(?!.*\bskills?\b).*\b(?:tools|software|technolog(?:y|ies))\b/i, "tools"],
  [
    /\b(?:skills?|competenc(?:y|ies)|expertise|technolog(?:y|ies)|technical (?:summary|profile|overview)|tools|proficienc)/i,
    "skills",
  ],
  [/\b(?:summary|profile|objective)\b/i, "summary"],
];

/**
 * A form question: a bold or numbered ("1. …") line ending in "?", or a bold
 * numbered prompt ("1. Describe your fulfillment experience …").
 */
function isQuestion(info: ParagraphInfo): boolean {
  const text = info.text.trim();
  const numbered = /^\d{1,2}[.)]\s/.test(text);
  if (text.length > 300) return false;
  return (/\?\s*\)?$/.test(text) && (info.bold || numbered)) || (numbered && info.bold);
}

/** The kind of content a template heading is for, if it says so clearly. */
function kindOfHeading(heading: string): string | null {
  return HEADING_KINDS.find(([pattern]) => pattern.test(heading))?.[1] ?? null;
}

/** Skills-like sections may share a template list (e.g. "Skills & Certifications"). */
function compatibleKinds(headingKind: string, sectionKind: string): boolean {
  if (headingKind === sectionKind) return true;
  // A section with a title of its own ("Additional Information", "Leadership") does
  // not belong under another kind of heading (Education, Skills, …): it goes to
  // the end instead of being shown under the wrong heading.
  if (sectionKind === "custom") return false;
  if (headingKind === "tools") return sectionKind === "skills";
  const listLike = new Set(["skills", "certifications", "languages"]);
  return headingKind === "skills" && listLike.has(sectionKind);
}

/**
 * The nearest heading above a group: for paragraphs, the closest label-like
 * paragraph before it; for table rows, the table's first row text or the
 * label-like paragraph just before the table.
 */
function headingAbove(
  group: FillGroup,
  blocks: BlockInfo[],
  paragraphs: Map<string, ParagraphAt>,
  rows: Map<string, RowAt>,
): string | null {
  // A strong label ("Skills:", "EDUCATION") is a heading; a bold short line is
  // one only if it names a section (a bold job title is not).
  const labelText = (block: BlockInfo | undefined) =>
    block?.kind === "paragraph" &&
    !block.empty &&
    (isLabelLike(block.text, false) || (isHeadingLike(block) && kindOfHeading(block.text)))
      ? block.text
      : null;
  if (group.blocks.length) {
    const first = paragraphs.get(group.blocks[0]!)?.index;
    if (first === undefined) return null;
    for (let index = first - 1; index >= 0; index--) {
      const block = blocks[index]!;
      if (block.kind !== "paragraph") return null;
      const text = labelText(block);
      if (text) return text;
      // Lines of sample entries (titles, dated lines, bullets) are skipped:
      // the section heading above them decides.
    }
    return null;
  }
  const row = rows.get(group.rows[0]!);
  if (!row) return null;
  const tableIndex = blocks.findIndex((block) => block.id === row.tableId);
  const table = blocks[tableIndex];
  if (table?.kind === "table") {
    for (const tableRow of table.rows.slice(0, row.index)) {
      const text = tableRow.cells
        .map((cell) => cell.text)
        .join(" ")
        .trim();
      if (text && kindOfHeading(text)) return text;
    }
  }
  for (let index = tableIndex - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind !== "paragraph") return null;
    const text = labelText(block);
    if (text) return text;
    if (!block.empty) return null;
  }
  return null;
}

/**
 * Fills for a repeat group the model left empty, read from the sample
 * entry's shape: a dated line ("Employer<TAB>dates") gets the employer and
 * dates, a single title line the job title, the first bullet the entry's
 * text; a per-item group shows the item; a table row gets employer/school,
 * title/degree and dates in column order.
 */
function inferGroupFills(
  group: FillGroup,
  paragraphs: Map<string, ParagraphAt>,
  rows: Map<string, RowAt>,
  content: ResumeContent,
): Fill[] {
  const kind = content.sections[Number(group.source.slice(1))]?.kind;
  if (group.rows.length > 0) {
    const cellIds = rows.get(group.rows[0]!)?.cellIds ?? [];
    if (cellIds.length === 0) return [];
    if (group.per === "item") return [{ block: cellIds[0]!, refs: ["entry.item"] }];
    if (cellIds.length === 1) {
      return [{ block: cellIds[0]!, refs: ["entry.subheading+entry.heading+entry.dates"] }];
    }
    const order = ["entry.subheading", "entry.heading", "entry.dates"];
    return cellIds.slice(0, 3).map((block, i) => ({ block, refs: [order[i]!] }));
  }

  const infos = group.blocks
    .map((id) => paragraphs.get(id)?.info)
    .filter((info): info is ParagraphInfo => Boolean(info && !info.empty));
  if (group.per === "item") {
    // An empty bullet line can carry the item too.
    const first = infos[0] ?? paragraphs.get(group.blocks[0]!)?.info;
    return first ? [{ block: first.id, refs: ["entry.item"] }] : [];
  }
  if (infos.length === 0) return [];

  const fills: Fill[] = [];
  const dated = infos.find((info) => info.segments.length > 1 && DATED.test(info.text));
  const title = infos.find(
    (info) => info !== dated && !info.numbered && info.segments.length === 1,
  );
  const bullet = infos.find((info) => info.numbered && info !== dated && info !== title);
  if (dated) {
    const refs: (string | null)[] = dated.segments.map(() => null);
    refs[0] = title ? "entry.subheading+entry.location" : "entry.heading+entry.subheading";
    refs[refs.length - 1] = "entry.dates";
    fills.push({ block: dated.id, refs });
  }
  if (title) {
    fills.push({
      block: title.id,
      refs: [dated ? "entry.heading" : "entry.heading+entry.subheading+entry.dates"],
    });
  }
  if (bullet) {
    const onlyLine = !dated && !title && kind !== "experience" && kind !== "projects";
    fills.push({
      block: bullet.id,
      refs: [onlyLine ? "entry.heading+entry.subheading+entry.dates" : "entry.text"],
    });
  }
  return fills;
}

/** A paragraph's look: list item, bold, several tab segments. */
const shapeOf = (info: ParagraphInfo) =>
  `${info.numbered ? "n" : ""}${info.bold ? "b" : ""}${info.segments.length > 1 ? "t" : ""}`;

const DATED = /\b(?:19|20)\d{2}\b|\bpresent\b|\bcurrent\b/i;

export function finalizeFillPlan(
  aiPlan: AIFillPlan,
  content: ResumeContent,
  blocks: BlockInfo[],
  source: PlanSource,
  /** Sample values found by the template analysis (placeholders), removed wherever the plan leaves them. */
  samples: readonly string[] = [],
): FinalizeFillResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  // --- block index ---
  const paragraphs = new Map<string, ParagraphAt>();
  const rows = new Map<string, RowAt>();
  const cells = new Map<string, { opaque: boolean; rowId: string; text: string }>();
  blocks.forEach((block, index) => {
    if (block.kind === "paragraph") paragraphs.set(block.id, { info: block, index });
    else {
      block.rows.forEach((row, rowIndex) => {
        rows.set(row.id, {
          tableId: block.id,
          index: rowIndex,
          span: row.span,
          cellIds: row.cells.map((cell) => cell.id),
        });
        for (const cell of row.cells) {
          cells.set(cell.id, { opaque: cell.opaque, rowId: row.id, text: cell.text });
        }
      });
    }
  });
  const knownBlock = (id: string) => paragraphs.has(id) || cells.has(id);

  // An empty paragraph that only ends a section (the blank bullet before a
  // two-column skills list), or the blank line after a bullet list, is no
  // place for content: what the plan put
  // there moves down the list that follows, one place each (or, with no
  // list after it, to the end), and the blank paragraph goes (its section
  // break stays).
  {
    const fills = aiPlan.fills.map((fill) => ({ ...fill }));
    const carriers = new Map<string, string>(); // blank paragraph → the item after it
    for (const [id, { info, index }] of paragraphs) {
      if (!info.empty || !fills.some((fill) => fill.block === id)) continue;
      // The blank line closing a bullet list counts too: text there would
      // read as a list item without its bullet.
      let back = index - 1;
      while (
        back >= 0 &&
        blocks[back]!.kind === "paragraph" &&
        (blocks[back] as ParagraphInfo).empty
      )
        back--;
      const before = blocks[back];
      const closesList = before?.kind === "paragraph" && before.numbered && !info.numbered;
      if (!info.sectionEnd && !closesList) continue;
      const chain = [id];
      for (let at = index + 1; at < blocks.length; at++) {
        const block = blocks[at]!;
        if (block.kind !== "paragraph" || !block.numbered || block.empty) break;
        chain.push(block.id);
      }
      // (With no list after it, the content goes to the end instead.)
      const onChain = chain.map((block) => fills.find((fill) => fill.block === block));
      onChain.forEach((fill, k) => {
        if (fill && k + 1 < chain.length) fill.block = chain[k + 1]!;
        else if (fill) fills.splice(fills.indexOf(fill), 1);
      });
      carriers.set(id, chain[1] ?? id);
    }
    if (carriers.size) {
      const filled = new Set(fills.map((fill) => fill.block));
      aiPlan = {
        ...aiPlan,
        fills,
        clears: [...aiPlan.clears.filter((id) => !filled.has(id)), ...carriers.keys()],
        groups: aiPlan.groups.map((group) => ({
          ...group,
          blocks: [...new Set(group.blocks.map((block) => carriers.get(block) ?? block))],
        })),
      };
    }
  }

  // A repeat group must hold ONE sample entry. When the plan's group spans
  // several of the template's sample jobs and fills the later ones with
  // explicit references ("s3.e1.heading"), every clone would print every
  // sample job's lines again (each real job shown three times). The group is
  // cut where the second sample job starts; that job's lines are cleared.
  {
    const dropped = new Set<string>();
    const cutGroups = aiPlan.groups.map((group) => {
      // A table group per item (one skill per row) repeats ONE row. When the
      // plan lists several sample rows and fills each, every item would be
      // printed once per sample row: only the first filled row stays.
      if (group.per === "item" && group.rows.length > 1) {
        const filledRows = group.rows.filter((row) =>
          aiPlan.fills.some((fill) => fill.block.startsWith(`${row}.`)),
        );
        if (filledRows.length > 1) {
          for (const row of group.rows.filter((id) => id !== filledRows[0])) dropped.add(row);
          return { ...group, rows: [filledRows[0]!] };
        }
        return group;
      }
      if (group.per !== "entry" || group.rows.length > 0 || group.blocks.length < 2) return group;
      const own = new RegExp(`^${group.source}\\.e(\\d+)\\.`);
      let first: string | null = null;
      let cut = -1;
      group.blocks.forEach((id, index) => {
        const fill = aiPlan.fills.find((candidate) => candidate.block === id);
        for (const ref of fill?.refs ?? []) {
          for (const part of ref ? refParts(ref) : []) {
            const entry = own.exec(part)?.[1];
            if (entry === undefined) {
              // Another section's content (a specific entry, or a whole
              // section) in a later line is not part of this entry.
              if (index > 0 && /^s\d+(?:\.e\d+\.|$)/.test(part) && cut === -1) cut = index;
              continue;
            }
            if (first === null) first = entry;
            else if (entry !== first && cut === -1) cut = index;
          }
        }
      });
      if (cut <= 0) return group;
      for (const id of group.blocks.slice(cut)) dropped.add(id);
      return { ...group, blocks: group.blocks.slice(0, cut) };
    });
    if (dropped.size > 0) {
      aiPlan = {
        ...aiPlan,
        groups: cutGroups,
        fills: aiPlan.fills.filter(
          (fill) =>
            !dropped.has(fill.block) && ![...dropped].some((id) => fill.block.startsWith(`${id}.`)),
        ),
        clears: [...new Set([...aiPlan.clears, ...dropped])],
        keeps: aiPlan.keeps.filter((id) => !dropped.has(id)),
      };
    }
  }

  // A specific field of a specific entry ("s2.e0.subheading") is shown once:
  // when the plan puts it in two lines, the first (in document order) keeps
  // it and the later line loses that part (a line left empty is cleared).
  {
    const order = new Map<string, number>();
    blocks.forEach((block, index) => {
      if (block.kind === "paragraph") order.set(block.id, index);
      else
        block.rows.forEach((row, r) =>
          row.cells.forEach((cell, c) => order.set(cell.id, index + (r * 100 + c) / 100000)),
        );
    });
    const inGroupBlocks = new Set(
      aiPlan.groups.flatMap((group) => [
        ...group.blocks,
        ...group.rows.flatMap((row) => [row, ...(rows.get(row)?.cellIds ?? [])]),
      ]),
    );
    const seen = new Set<string>();
    const removed = new Set<string>();
    const fills = aiPlan.fills
      .map((fill) => ({ ...fill }))
      .sort((a, b) => (order.get(a.block) ?? 1e9) - (order.get(b.block) ?? 1e9));
    for (const fill of fills) {
      if (inGroupBlocks.has(fill.block)) continue;
      fill.refs = fill.refs.map((ref) => {
        if (ref === null || ref === "-") return ref;
        const kept = refParts(ref).filter((part) => {
          if (!/^s\d+\.e\d+\.\w+$/.test(part)) return true;
          if (seen.has(part)) return false;
          seen.add(part);
          return true;
        });
        return kept.length === refParts(ref).length ? ref : kept.length ? kept.join("+") : "-";
      });
      if (fill.refs.every((ref) => ref === "-") && paragraphs.has(fill.block))
        removed.add(fill.block);
    }
    if (seen.size > 0) {
      aiPlan = {
        ...aiPlan,
        fills: fills.filter((fill) => !removed.has(fill.block)),
        clears: [...new Set([...aiPlan.clears, ...removed])],
      };
    }
  }

  // --- 2. groups ---
  const groups: FillGroup[] = [];
  const grouped = new Map<string, FillGroup>(); // block/row id → its group
  const usedSources = new Set<string>();
  const blockIdAt = new Map<number, string>();
  for (const [id, at] of paragraphs) blockIdAt.set(at.index, id);
  for (const listed of aiPlan.groups) {
    // A group listed with gaps (its sample bullets skipped because they are
    // cleared) covers the whole span: cleared blocks inside it are simply
    // left out of every clone.
    let group = listed;
    if (listed.blocks.length > 1 && listed.rows.length === 0) {
      const at = listed.blocks.map((id) => paragraphs.get(id)?.index);
      if (at.every((place): place is number => place !== undefined)) {
        const from = Math.min(...at);
        const to = Math.max(...at);
        const span: string[] = [];
        for (let index = from; index <= to; index++) {
          const id = blockIdAt.get(index);
          if (!id) break; // a table in between: not one entry
          span.push(id);
        }
        if (span.length === to - from + 1) group = { ...listed, blocks: span };
      }
    } else if (listed.rows.length > 1) {
      const at = listed.rows.map((id) => rows.get(id));
      if (at.every(Boolean) && new Set(at.map((row) => row!.tableId)).size === 1) {
        const table = at[0]!.tableId;
        const from = Math.min(...at.map((row) => row!.index));
        const to = Math.max(...at.map((row) => row!.index));
        group = {
          ...listed,
          rows: [...rows]
            .filter(([, row]) => row.tableId === table && row.index >= from && row.index <= to)
            .map(([id]) => id),
        };
      }
    }
    const section = /^s(\d+)$/.exec(group.source);
    if (!section || !content.sections[Number(section[1])]) {
      issues.push(`Group source "${group.source}" does not exist.`);
      continue;
    }
    if (usedSources.has(group.source)) {
      issues.push(`Section "${group.source}" has more than one repeat group.`);
      continue;
    }
    const ids = group.blocks.length ? group.blocks : group.rows;
    const places = group.blocks.length
      ? group.blocks.map((id) => paragraphs.get(id)?.index)
      : group.rows.map((id) => rows.get(id)?.index);
    const tables = new Set(group.rows.map((id) => rows.get(id)?.tableId));
    const consecutive =
      places.every((place): place is number => place !== undefined) &&
      places.every((place, i) => i === 0 || place === places[i - 1]! + 1) &&
      (group.blocks.length === 0 || group.rows.length === 0) &&
      tables.size <= 1;
    if (!consecutive) {
      issues.push(
        `Group for "${group.source}" must list consecutive body paragraphs or consecutive rows of one table (${ids.join(", ")}).`,
      );
      continue;
    }
    if (ids.some((id) => grouped.has(id))) {
      issues.push(`Blocks of the group for "${group.source}" are already in another group.`);
      continue;
    }
    usedSources.add(group.source);
    groups.push(group);
    for (const id of ids) grouped.set(id, group);
    for (const id of group.rows)
      for (const cellId of rows.get(id)!.cellIds) grouped.set(cellId, group);
  }

  // The blank line(s) the template leaves between its sample entries
  // separate the cloned entries too. The plan's group often covers only the
  // sample entry's first lines (its other bullets are cleared), so the
  // separator is the first blank line after the group, however many sample
  // bullets sit in between: the group is extended up to and including it.
  groups.forEach((group, at) => {
    if (group.per !== "entry" || group.blocks.length === 0) return;
    const last = paragraphs.get(group.blocks.at(-1)!);
    // (A group that already ends with its blank separator needs no extension.)
    if (!last || last.info.empty) return;
    const planFilled = new Set(aiPlan.fills.map((fill) => fill.block));
    const planKept = new Set(aiPlan.keeps);
    const rest: string[] = [];
    let found = false;
    for (let index = last.index + 1; index < blocks.length && rest.length < 60; index++) {
      const block = blocks[index]!;
      if (block.kind !== "paragraph" || grouped.has(block.id) || planFilled.has(block.id)) break;
      if (planKept.has(block.id) || block.sectionEnd) break;
      if (block.empty) {
        rest.push(block.id);
        found = true;
        // A separator of two blank lines stays two.
        const following = blocks[index + 1];
        if (following?.kind === "paragraph" && following.empty && !following.sectionEnd) {
          const id = following.id;
          if (!grouped.has(id) && !planFilled.has(id) && !planKept.has(id)) rest.push(id);
        }
        break;
      }
      // The rest of the sample entry — never the next section's heading.
      if (isHeadingLike(block) && kindOfHeading(block.text) !== null) break;
      rest.push(block.id);
    }
    if (!found) return;
    const extended = { ...group, blocks: [...group.blocks, ...rest] };
    groups[at] = extended;
    for (const id of extended.blocks) grouped.set(id, extended);
  });

  // --- 1. fills ---
  const fills: Fill[] = [];
  const filledBlocks = new Set<string>();
  const placed = new Set<string>(); // "summary", "sN.eM"
  const placedFields = new Map<string, Set<string>>(); // direct "sN.eM" → fields filled
  const contactShown = new Set<ContactField>();
  // Labelled fields ("Pay Rate: $36/hr", "Location: …") take only what
  // their label is for; anything else is refused and the field is cleared
  // (its label stays).
  const labelClears = new Set<string>();
  for (const fill of aiPlan.fills) {
    const label = inlineLabel(paragraphs.get(fill.block)?.info.text ?? cells.get(fill.block)?.text);
    if (
      label &&
      knownBlock(fill.block) &&
      !labelFits(label, fill.refs, grouped.get(fill.block), content)
    ) {
      issues.push(
        `Block "${fill.block}" is the "${label.trim()}" field, which does not fit ${fill.refs.filter(Boolean).join(", ")}; clear it instead.`,
      );
      labelClears.add(fill.block);
    }
  }
  // Content filled straight into a block under another section's heading
  // (languages in the "Internships" area, the summary in "Skills") is
  // refused the same way. Each piece is shown once: a section that has a
  // repeat group is not filled again elsewhere, and when the summary is
  // filled into several places, the candidate summary wins over a
  // recruiter's or supplier's comment box.
  const headingOf = (block: string) =>
    headingAbove(
      cells.has(block)
        ? { source: "s0", per: "entry", blocks: [], rows: [cells.get(block)!.rowId] }
        : { source: "s0", per: "entry", blocks: [block], rows: [] },
      blocks,
      paragraphs,
      rows,
    );
  const groupSources = new Set(groups.map((group) => group.source));
  const shownSections = new Set<string>();
  // Sections with some entry placed by an explicit "sN.eK.field" reference
  // (wherever the plan lists it): the whole section is not shown again.
  const sectionsWithEntries = new Set<string>();
  for (const fill of aiPlan.fills) {
    if (grouped.has(fill.block)) continue;
    for (const ref of fill.refs) {
      for (const part of ref ? refParts(ref) : []) {
        const section = /^(s\d+)\.e\d+\./.exec(part)?.[1];
        if (section) sectionsWithEntries.add(section);
      }
    }
  }
  // Static wording the plan wrongly filled ("Available on request …") stays.
  const refusedKeep = new Set<string>();
  const STATIC_WORDING =
    /\b(?:available|upon request|on request|references?|confidential|proprietary|all rights|equal opportunity)\b/i;
  const summaryPlaces: { block: string; score: number }[] = [];
  for (const fill of aiPlan.fills) {
    if (labelClears.has(fill.block) || grouped.has(fill.block) || !knownBlock(fill.block)) continue;
    const parts = fill.refs.flatMap((ref) => (ref ? refParts(ref) : []));
    const kinds = parts.flatMap((part) => {
      if (part === "summary") return ["summary"];
      const section = /^s(\d+)(?:\.|$)/.exec(part)?.[1];
      return section ? [planKindForSection(content, Number(section))] : [];
    });
    if (kinds.length === 0) continue;
    const heading = headingOf(fill.block);
    const headingKind = heading ? kindOfHeading(heading) : null;
    if (headingKind && kinds.some((kind) => !compatibleKinds(headingKind, kind))) {
      issues.push(
        `Block "${fill.block}" sits under the heading "${heading}", which is for other content.`,
      );
      labelClears.add(fill.block);
      continue;
    }
    const again = parts.find((part) => {
      const section = /^s\d+/.exec(part)?.[0] ?? "";
      if (groupSources.has(section)) return true;
      if (/^s\d+$/.test(part)) return shownSections.has(part) || sectionsWithEntries.has(part);
      return /^s\d+\.e\d+\./.test(part) && shownSections.has(section);
    });
    if (again) {
      issues.push(`Block "${fill.block}" shows "${again}", which is already shown elsewhere.`);
      const text = paragraphs.get(fill.block)?.info.text ?? "";
      if (text.length <= 120 && STATIC_WORDING.test(text)) refusedKeep.add(fill.block);
      else labelClears.add(fill.block);
      continue;
    }
    for (const part of parts) {
      const section = /^(s\d+)\.e\d+\./.exec(part)?.[1];
      if (section) sectionsWithEntries.add(section);
    }
    // The summary is a paragraph of text: a short bold or centered header
    // line (the name or contact line under it) is no place for it.
    const sample = paragraphs.get(fill.block)?.info;
    if (
      parts.includes("summary") &&
      sample &&
      sample.text.length < 60 &&
      (sample.bold || sample.align === "center")
    ) {
      issues.push(`Block "${fill.block}" is a short header line, not a place for the summary.`);
      labelClears.add(fill.block);
      continue;
    }
    for (const part of parts) if (/^s\d+$/.test(part)) shownSections.add(part);
    if (parts.includes("summary")) {
      const forOthers = heading && /recruit|supplier|vendor|comment|submission/i.test(heading);
      summaryPlaces.push({
        block: fill.block,
        score: headingKind === "summary" ? (forOthers ? 1 : 2) : 0,
      });
    }
  }
  if (summaryPlaces.length > 1) {
    const best = summaryPlaces.reduce((a, b) => (b.score > a.score ? b : a));
    for (const place of summaryPlaces) {
      if (place === best) continue;
      issues.push(`The summary is filled more than once; block "${place.block}" is cleared.`);
      labelClears.add(place.block);
    }
  }
  // A section heading ("Professional Summary:") is never filled — not even
  // with the candidate's name when the template has no name line (the name
  // is then added at the top).
  const sectionHeadings = new Set<string>();
  for (const fill of aiPlan.fills) {
    const info = paragraphs.get(fill.block)?.info;
    if (
      info &&
      !grouped.has(fill.block) &&
      isHeadingLike(info) &&
      kindOfHeading(info.text) !== null
    ) {
      issues.push(`Block "${fill.block}" is the section heading "${info.text}"; leave it.`);
      sectionHeadings.add(fill.block);
    }
  }
  for (const fill of aiPlan.fills) {
    if (
      labelClears.has(fill.block) ||
      sectionHeadings.has(fill.block) ||
      refusedKeep.has(fill.block)
    )
      continue;
    if (!knownBlock(fill.block)) {
      issues.push(`Block "${fill.block}" does not exist.`);
      continue;
    }
    if (cells.get(fill.block)?.opaque) {
      issues.push(`Cell "${fill.block}" cannot be filled (it holds a nested table); leave it.`);
      continue;
    }
    if (filledBlocks.has(fill.block)) {
      issues.push(`Block "${fill.block}" is filled more than once.`);
      continue;
    }
    const inGroup = grouped.has(fill.block);
    const refs = fill.refs.map((ref) => {
      if (ref === null) return null;
      const parts = refParts(ref).filter((part) => {
        if (part === "-") return true;
        if (part.startsWith("entry.")) {
          if (!inGroup) {
            issues.push(`Block "${fill.block}" uses "${part}" but is not in a repeat group.`);
            return false;
          }
          return true;
        }
        if ((CONTACT_REFS as readonly string[]).includes(part)) {
          contactShown.add(part.slice("contact.".length) as ContactField);
          return true;
        }
        if (part === "summary") {
          if (!content.summary) {
            issues.push(`Reference "summary" does not exist (the resume has no summary).`);
            return false;
          }
          placed.add("summary");
          return true;
        }
        const whole = /^s(\d+)$/.exec(part);
        if (whole) {
          const section = content.sections[Number(whole[1])];
          if (!section) {
            issues.push(`Reference "${part}" does not exist.`);
            return false;
          }
          section.entries.forEach((_entry, e) => placed.add(entryRef(Number(whole[1]), e)));
          return true;
        }
        const entry = /^(s\d+\.e\d+)\.(\w+)$/.exec(part);
        if (entry && resolveEntryRef(content, entry[1]!)) {
          const fields = placedFields.get(entry[1]!) ?? new Set<string>();
          fields.add(entry[2]!);
          placedFields.set(entry[1]!, fields);
          return true;
        }
        issues.push(`Reference "${part}" does not exist.`);
        return false;
      });
      return parts.length ? parts.join("+") : null;
    });
    if (refs.every((ref) => ref === null)) continue;
    fills.push({ block: fill.block, refs });
    filledBlocks.add(fill.block);
  }

  // A group whose fills all show one OTHER section ("s3", "s3.e0.heading"),
  // never "entry.*", repeats for the wrong section: point it at that one.
  for (const group of groups) {
    const ids = group.blocks.length ? group.blocks : group.rows;
    const parts = fills
      .filter((fill) => ids.some((id) => fill.block === id || fill.block.startsWith(`${id}.`)))
      .flatMap((fill) => fill.refs.flatMap((ref) => (ref ? refParts(ref) : [])));
    const sections = new Set(parts.map((part) => /^(s\d+)(?:\.|$)/.exec(part)?.[1]));
    const [other] = [...sections];
    if (
      parts.length > 0 &&
      sections.size === 1 &&
      other &&
      other !== group.source &&
      !usedSources.has(other)
    ) {
      usedSources.delete(group.source);
      usedSources.add(other);
      issues.push(`Group for "${group.source}" shows "${other}"; its source should be "${other}".`);
      group.source = other;
    }
  }

  // A group under a heading for another kind of section (skills repeated in
  // the template's "Languages" list) would put content under the wrong
  // heading: it is dropped, and that section goes to the end instead.
  for (const group of [...groups]) {
    const heading = headingAbove(group, blocks, paragraphs, rows);
    const headingKind = heading ? kindOfHeading(heading) : null;
    const sectionKind = planKindForSection(content, Number(group.source.slice(1)));
    if (!headingKind || compatibleKinds(headingKind, sectionKind)) continue;
    issues.push(
      `Group for "${group.source}" sits under the heading "${heading}", which is for other content.`,
    );
    groups.splice(groups.indexOf(group), 1);
    usedSources.delete(group.source);
    for (const [id, owner] of [...grouped]) if (owner === group) grouped.delete(id);
  }

  // A repeat group must show something: one with no filled block (or whose
  // blocks are all cleared) would make its section vanish. Such a group is
  // dropped (its section then goes to the end), with its "entry.*" fills.
  const clearedIds = new Set(aiPlan.clears);
  for (const group of [...groups]) {
    const ids = group.blocks.length ? group.blocks : group.rows;
    const shows = fills.some(
      (fill) =>
        !clearedIds.has(fill.block) &&
        ids.some((id) => fill.block === id || fill.block.startsWith(`${id}.`)),
    );
    if (shows) continue;
    issues.push(
      `Group for "${group.source}" has no filled block; fill its blocks with "entry.*" refs and do not clear them.`,
    );
    // The model named the sample entry but not its fields: read them from the
    // template's own shapes rather than losing the section's place.
    const inferred = inferGroupFills(group, paragraphs, rows, content);
    if (inferred.length > 0) {
      for (const fill of inferred) {
        fills.push(fill);
        filledBlocks.add(fill.block);
        clearedIds.delete(fill.block);
      }
      continue;
    }
    groups.splice(groups.indexOf(group), 1);
    usedSources.delete(group.source);
    for (const [id, owner] of [...grouped]) if (owner === group) grouped.delete(id);
  }
  for (let i = fills.length - 1; i >= 0; i--) {
    const fill = fills[i]!;
    if (grouped.has(fill.block)) continue;
    if (
      fill.refs.some((ref) => ref !== null && refParts(ref).some((p) => p.startsWith("entry.")))
    ) {
      fills.splice(i, 1);
      filledBlocks.delete(fill.block);
    }
  }

  // A segment left as it is ("null") that holds a sample value — the role
  // line's own dates "Title<TAB>Jun 2025 – Aug 2025" — is emptied ("-").
  // Segments the plan does not mention at all (one ref for a two-part line)
  // count the same.
  for (const fill of fills) {
    const info = paragraphs.get(fill.block)?.info;
    if (!info) continue;
    const refs =
      info.segments.length > fill.refs.length
        ? [...fill.refs, ...info.segments.slice(fill.refs.length).map(() => null)]
        : fill.refs;
    fill.refs = refs.map((ref, index) => {
      const sample = info.segments[index];
      return ref === null && sample && !isLabelLike(sample, false) ? "-" : ref;
    });
  }

  // Inside one repeated entry each field is shown once: a later line that
  // repeats fields an earlier line already shows keeps only the new ones.
  for (const group of groups) {
    const ids = group.blocks.length ? group.blocks : group.rows;
    const ownSection = new RegExp(`^${group.source}\\.e\\d+\\.(\\w+)$`);
    const shown = new Set<string>();
    for (const fill of fills) {
      if (!ids.some((id) => fill.block === id || fill.block.startsWith(`${id}.`))) continue;
      fill.refs = fill.refs.map((ref) => {
        if (ref === null || ref === "-") return ref;
        const fresh = refParts(ref).flatMap((part) => {
          // (An explicit reference to the group's own section reads as the entry's.)
          const field = /^entry\.(\w+)$/.exec(part)?.[1] ?? ownSection.exec(part)?.[1];
          if (!field || field === "item") return [part];
          if (field === "text") {
            // "text" is the description and the bullets: only what no earlier
            // line already shows is left.
            const left = ["description", "bullets"].filter((name) => !shown.has(name));
            for (const name of left) shown.add(name);
            if (left.length === 0) return [];
            return left.length === 2 ? [part] : [`entry.${left[0]}`];
          }
          const covers = field === "dates" ? ["dates", "startDate", "endDate"] : [field];
          if (covers.some((name) => shown.has(name))) return [];
          for (const name of covers) shown.add(name);
          return [part];
        });
        return fresh.length ? fresh.join("+") : "-";
      });
    }
    // A per-item group shows the item once: when the plan filled several of
    // its sample lines with the item (or its fields), only the first stays.
    if (group.per === "item") {
      const filledLines = fills.filter((fill) => group.blocks.includes(fill.block));
      for (const extra of filledLines.slice(1)) {
        fills.splice(fills.indexOf(extra), 1);
        filledBlocks.delete(extra.block);
        labelClears.add(extra.block);
      }
    }
    // A line left with nothing to show would stay as a blank line in every
    // clone: it is removed instead.
    for (const fill of [...fills]) {
      if (!group.blocks.includes(fill.block)) continue;
      if (!fill.refs.every((ref) => ref === "-")) continue;
      fills.splice(fills.indexOf(fill), 1);
      filledBlocks.delete(fill.block);
      labelClears.add(fill.block);
    }
  }

  // One entry spread over consecutive list items ("• Degree" then
  // "• School, dates") would read as two entries: each sample bullet was a
  // whole entry, so the parts are joined in the first one.
  {
    const ownerOf = (fill: Fill) => {
      const owners = new Set(
        fill.refs.flatMap((ref) =>
          ref && ref !== "-" ? refParts(ref).map((part) => /^(s\d+\.e\d+)\./.exec(part)?.[1]) : [],
        ),
      );
      return owners.size === 1 ? ([...owners][0] ?? null) : null;
    };
    const byBlock = new Map(fills.map((fill) => [fill.block, fill]));
    for (const fill of [...fills]) {
      const at = paragraphs.get(fill.block);
      const owner = ownerOf(fill);
      if (!at?.info.numbered || !owner || grouped.has(fill.block) || fill.refs.length !== 1)
        continue;
      const nextId = blockIdAt.get(at.index + 1);
      const next = nextId ? byBlock.get(nextId) : undefined;
      if (!next || !paragraphs.get(next.block)!.info.numbered || grouped.has(next.block)) continue;
      if (next.refs.length !== 1 || ownerOf(next) !== owner) continue;
      fill.refs = [`${fill.refs[0]}+${next.refs[0]}`];
      fills.splice(fills.indexOf(next), 1);
      byBlock.delete(next.block);
      filledBlocks.delete(next.block);
      labelClears.add(next.block);
    }
  }

  // Table rows showing one entry:
  // - a column the entry leaves blank (a language has no "subheading") while
  //   a later column shows its title ("english spanish" under "Years of
  //   Experience", "Skill/Competency" empty) swap, so the title comes first;
  // - an unfilled date column ("Completed", "Year") shows the entry's dates
  //   instead of them being appended to another cell.
  const cellFills = new Map(fills.map((fill) => [fill.block, fill]));
  const SCALAR = /^(entry|s\d+\.e\d+)\.(heading|subheading|location|startDate|endDate|dates)$/;
  for (const [rowId, row] of rows) {
    const rowFills = row.cellIds.map((id) => cellFills.get(id));
    const owners = new Set(
      rowFills.flatMap((fill) =>
        (fill?.refs ?? []).flatMap((ref) =>
          ref ? refParts(ref).flatMap((part) => /^(entry|s\d+\.e\d+)\./.exec(part)?.[1] ?? []) : [],
        ),
      ),
    );
    if (owners.size !== 1) continue;
    const owner = [...owners][0]!;
    const source = grouped.get(rowId)?.source;
    const entries =
      owner === "entry"
        ? source
          ? (content.sections[Number(source.slice(1))]?.entries ?? [])
          : []
        : [resolveEntryRef(content, owner)?.entry].filter((entry) => entry !== undefined);
    if (entries.length === 0) continue;
    const blank = (field: string) =>
      entries.every((entry) =>
        field === "dates"
          ? !entry.startDate && !entry.endDate
          : !entry[field as "heading" | "subheading" | "location" | "startDate" | "endDate"],
      );
    const single = (fill: Fill | undefined) =>
      fill?.refs.length === 1 && fill.refs[0] ? SCALAR.exec(fill.refs[0]) : null;
    for (let i = 0; i < rowFills.length; i++) {
      const first = single(rowFills[i]);
      if (!first || !blank(first[2]!)) continue;
      const laterIndex = rowFills.findIndex((fill, j) => {
        const later = single(fill);
        return j > i && later !== null && !blank(later[2]!);
      });
      if (laterIndex === -1) continue;
      const a = rowFills[i]!;
      const b = rowFills[laterIndex]!;
      [a.refs, b.refs] = [b.refs, a.refs];
    }
    const showsDates = rowFills.some((fill) =>
      (fill?.refs ?? []).some((ref) => ref && /\.(?:dates|startDate|endDate)\b/.test(ref)),
    );
    if (showsDates || blank("dates")) continue;
    // The nearest header row above with the same columns.
    const header = (index: number) => {
      let found = "";
      for (const [, other] of rows) {
        if (other.tableId !== row.tableId || other.index >= row.index) continue;
        if (other.cellIds.length !== row.cellIds.length) continue;
        const text = cells.get(other.cellIds[index]!)?.text.trim();
        if (text && isLabelLike(text, false)) found = text;
      }
      return found;
    };
    const dateColumn = row.cellIds.findIndex(
      (id, index) =>
        !cellFills.has(id) &&
        !cells.get(id)?.opaque &&
        /complet|graduat|\byears?\b|\bdates?\b|period|when/i.test(header(index)) &&
        !/experience/i.test(header(index)),
    );
    if (dateColumn === -1) continue;
    const cellId = row.cellIds[dateColumn]!;
    fills.push({ block: cellId, refs: [`${owner}.dates`] });
    filledBlocks.add(cellId);
    if (owner !== "entry") placedFields.get(owner)?.add("dates");
  }

  // A single date column (e.g. "Completed") shows the entry's whole date
  // range, so a start date is never lost: "startDate"/"endDate" alone become "dates".
  const dateFields = new Map<string, Set<string>>();
  const dateKey = (block: string, owner: string) =>
    owner === "entry" ? `group:${grouped.get(block)?.source}` : owner;
  for (const fill of fills) {
    for (const part of fill.refs.flatMap((ref) => (ref ? refParts(ref) : []))) {
      const match = /^(entry|s\d+\.e\d+)\.(startDate|endDate|dates)$/.exec(part);
      if (!match) continue;
      const key = dateKey(fill.block, match[1]!);
      dateFields.set(key, (dateFields.get(key) ?? new Set()).add(match[2]!));
    }
  }
  for (const fill of fills) {
    fill.refs = fill.refs.map((ref) => {
      if (ref === null) return null;
      const parts = refParts(ref);
      // Start and end date in the same place read as one range ("Feb 2009 – 2015").
      for (const owner of new Set(parts.map((part) => part.split(".").slice(0, -1).join(".")))) {
        const start = parts.indexOf(`${owner}.startDate`);
        const end = parts.indexOf(`${owner}.endDate`);
        if (start !== -1 && end !== -1) {
          parts[Math.min(start, end)] = `${owner}.dates`;
          parts.splice(Math.max(start, end), 1);
        }
      }
      return parts
        .map((part) => {
          const match = /^(entry|s\d+\.e\d+)\.(startDate|endDate)$/.exec(part);
          if (!match) return part;
          const used = dateFields.get(dateKey(fill.block, match[1]!))!;
          const alone = !(used.has("startDate") && used.has("endDate")) && !used.has("dates");
          return alone ? `${match[1]}.dates` : part;
        })
        .join("+");
    });
  }
  for (const fields of placedFields.values()) {
    if (fields.has("startDate") !== fields.has("endDate")) fields.add("dates");
  }

  // --- keeps and clears ---
  const keeps = aiPlan.keeps.filter((id) => knownBlock(id) || rows.has(id));
  for (const id of refusedKeep) if (!keeps.includes(id)) keeps.push(id);
  // The client's own questions ("1. Are you able to lift 50 lbs?") are form
  // text and always stay; only the sample answers under them go.
  for (const [id, { info }] of paragraphs) {
    if (isQuestion(info) && !filledBlocks.has(id) && !grouped.has(id) && !keeps.includes(id)) {
      keeps.push(id);
    }
  }
  const protectedIds = new Set([...filledBlocks, ...keeps, ...grouped.keys()]);
  const separators = new Set<string>();
  for (const group of groups) {
    if (group.per !== "entry") continue;
    for (let at = group.blocks.length - 1; at > 0; at--) {
      const id = group.blocks[at]!;
      if (!paragraphs.get(id)?.info.empty) break;
      separators.add(id);
    }
  }
  const clears = new Set<string>();
  for (const id of [...aiPlan.clears, ...labelClears]) {
    if (!knownBlock(id) && !rows.has(id)) {
      issues.push(`Block "${id}" does not exist.`);
      continue;
    }
    // A cleared cell or paragraph inside a group is emptied/omitted in every
    // clone (e.g. a "years of experience" cell); a group row itself cannot go.
    const groupRow = rows.has(id) && grouped.has(id);
    // The blank line(s) closing an entry group stay: they separate the clones.
    if (separators.has(id)) continue;
    if (filledBlocks.has(id) || keeps.includes(id) || groupRow) {
      issues.push(`Block "${id}" is both cleared and filled, kept or a repeated row.`);
      continue;
    }
    clears.add(id);
  }

  // A section heading stays when content is filled below it ("Skills:" with
  // the skills under it); clearing it would run that content into the
  // section above. (A heading over nothing may go.)
  const isHeading = (info: ParagraphInfo) =>
    !info.empty &&
    !inlineLabel(info.text) &&
    (isLabelLike(info.text, false) || (isHeadingLike(info) && kindOfHeading(info.text) !== null));
  const showsContent = (block: BlockInfo) =>
    block.kind === "paragraph"
      ? filledBlocks.has(block.id) || grouped.has(block.id)
      : block.rows.some(
          (row) => grouped.has(row.id) || row.cells.some((cell) => filledBlocks.has(cell.id)),
        );
  for (const id of [...clears]) {
    const at = paragraphs.get(id);
    if (!at || !isHeading(at.info)) continue;
    for (let index = at.index + 1; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.kind === "paragraph" && isHeading(block)) break;
      if (showsContent(block)) {
        clears.delete(id);
        break;
      }
    }
  }

  // Cells of a repeated row that the plan does not fill held the sample
  // entry's values ("3+ years", "Yes"): they are emptied in every clone.
  for (const group of groups) {
    for (const rowId of group.rows) {
      for (const cellId of rows.get(rowId)!.cellIds) {
        if (!filledBlocks.has(cellId) && !keeps.includes(cellId) && !cells.get(cellId)?.opaque) {
          clears.add(cellId);
        }
      }
    }
  }

  // Safety net: the template's sample person must never survive. A block the
  // plan does not mention (not filled, kept, cleared or repeated) whose text
  // is not static wording — or that contains a sample value the template
  // analysis found ("Lauren Wentworth") — is sample content and is removed.
  const sampleTexts = sampleValues(samples).map((sample) => sample.toLowerCase());
  // A line that is just a section heading ("Education", even in plain type) is the
  // template's own wording, never the sample person's content.
  const isSectionHeading = (text: string) =>
    text.length <= 40 && !/\d/.test(text) && kindOfHeading(text) !== null;
  const isSample = (text: string, bold: boolean) => {
    const lower = text.toLowerCase();
    return (
      (!isLabelLike(text, bold) && !isSectionHeading(text)) ||
      sampleTexts.some((sample) => lower.includes(sample))
    );
  };
  const groupParagraphs = new Set(groups.flatMap((group) => group.blocks));
  // Unfilled paragraphs inside a repeat group are checked too (a sample
  // bullet left in the group would otherwise be copied into every entry).
  const groupRowsAndCells = [...grouped.keys()].filter((id) => id.includes(".r"));
  // The rows above a repeated table row are its header ("Competency |
  // Years"): labels, even when they are not bold.
  const headerCells = new Set<string>();
  for (const group of groups) {
    if (!group.rows.length) continue;
    const first = rows.get(group.rows[0]!)!;
    for (const row of rows.values()) {
      if (row.tableId !== first.tableId || row.index >= first.index) continue;
      for (const cellId of row.cellIds) {
        const text = cells.get(cellId)?.text ?? "";
        if (text.length <= 60 && !/\b(?:19|20)\d{2}\b/.test(text)) headerCells.add(cellId);
      }
    }
  }
  const mentioned = new Set([
    ...filledBlocks,
    ...keeps,
    ...groupRowsAndCells,
    ...clears,
    ...headerCells,
  ]);
  let removed = 0;
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      if (mentioned.has(block.id) || block.empty) continue;
      if (isSample(block.text, groupParagraphs.has(block.id) ? false : block.bold)) {
        clears.add(block.id);
        removed++;
      }
      continue;
    }
    for (const row of block.rows) {
      if (mentioned.has(row.id)) continue;
      for (const cell of row.cells) {
        if (mentioned.has(cell.id) || cell.opaque || !cell.text) continue;
        if (isSample(cell.text, cell.bold)) {
          clears.add(cell.id);
          removed++;
        }
      }
    }
  }
  if (removed > 0) {
    warnings.push(`Sample details the plan left in the template were removed (${removed}).`);
  }

  // --- 5. leftover sample entries after repeat groups ---
  // Labels repeated in the template ("Project:" in every sample job) belong
  // to the entries, not to the document.
  const paragraphTextCount = new Map<string, number>();
  for (const { info } of paragraphs.values()) {
    if (!info.empty)
      paragraphTextCount.set(info.text, (paragraphTextCount.get(info.text) ?? 0) + 1);
  }
  let swept = 0;
  for (const group of groups) {
    if (group.rows.length) {
      const last = rows.get(group.rows.at(-1)!)!;
      const sample = rows.get(group.rows[0]!)!;
      for (const [id, row] of rows) {
        if (row.tableId !== last.tableId || row.index <= last.index) continue;
        if (row.span !== sample.span || row.cellIds.length !== sample.cellIds.length) break;
        if (protectedIds.has(id) || row.cellIds.some((cellId) => protectedIds.has(cellId))) break;
        if (!clears.has(id)) swept++;
        clears.add(id);
      }
      continue;
    }
    // More sample entries follow the group's sample entry: blocks shaped like
    // its lines (a bold title, a dated employer line, bullets) up to the next
    // real heading or label.
    const last = paragraphs.get(group.blocks.at(-1)!)!;
    const shapes = new Set(
      group.blocks
        .map((id) => paragraphs.get(id)!.info)
        .filter((info) => !info.empty)
        .map(shapeOf),
    );
    for (let index = last.index + 1; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.kind !== "paragraph" || protectedIds.has(block.id)) break;
      if (
        !block.empty &&
        (isLabelLike(block.text, false) || isSectionHeading(block.text)) &&
        !inlineLabel(block.text) &&
        (paragraphTextCount.get(block.text) ?? 0) < 2
      ) {
        break;
      }
      const sampleLike =
        block.empty ||
        block.numbered ||
        DATED.test(block.text) ||
        block.segments.length > 1 ||
        shapes.has(shapeOf(block)) ||
        (paragraphTextCount.get(block.text) ?? 0) >= 2 ||
        // "Gap Reason: …" between sample jobs is entry content too.
        inlineLabel(block.text) !== null;
      if (!sampleLike || (isHeadingLike(block) && !shapes.has(shapeOf(block)))) break;
      if (!clears.has(block.id)) swept++;
      clears.add(block.id);
    }
  }
  if (swept > 0) {
    warnings.push(
      `Sample entries left in the template after a repeated block were removed (${swept}).`,
    );
  }

  // A section heading whose sample entries were all removed and that shows
  // nothing of the candidate's ("Additional Manufacturing Experience" for a
  // candidate with one job, "Certification:" or "Capabilities:" for one
  // with none) goes too,
  // rather than standing empty. Summary and recruiter boxes are form fields
  // and keep their heading.
  for (const [id, { info, index: at }] of paragraphs) {
    if (protectedIds.has(id) || clears.has(id)) continue;
    if (!isHeading(info) || kindOfHeading(info.text) === "summary") continue;
    if (/recruit|supplier|vendor|comment|submission|question/i.test(info.text)) continue;
    let removed = 0;
    let empty = true;
    // Column-header rows ("Skill/Competency | Years") go with their heading.
    const headerRows: string[] = [];
    for (let index = at + 1; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.kind === "paragraph" && isHeading(block)) break;
      if (showsContent(block)) {
        empty = false;
        break;
      }
      if (block.kind === "paragraph") {
        if (clears.has(block.id)) removed++;
        else if (!block.empty) {
          empty = false;
          break;
        }
      } else {
        const kept = block.rows.filter((row) => !clears.has(row.id));
        const headers = kept.filter((row) =>
          row.cells.every((cell) => cell.bold && cell.text.trim() && !cell.opaque),
        );
        if (kept.length > headers.length || kept.length === block.rows.length) {
          empty = false;
          break;
        }
        headerRows.push(...headers.map((row) => row.id));
        removed++;
      }
    }
    if (empty && removed > 0) {
      clears.add(id);
      for (const row of headerRows) clears.add(row);
    }
  }

  // The same inside a table whose title rows head several blocks of rows
  // ("ADDITIONAL SKILLS, …", then its column headers and rows): a block whose
  // rows were all removed takes its title and column headers along.
  const isHeaderRow = (row: RowInfo) =>
    row.cells.every((cell) => cell.bold && cell.text.trim() && !cell.opaque);
  for (const block of blocks) {
    if (block.kind !== "table") continue;
    const { rows } = block;
    rows.forEach((title, at) => {
      if (clears.has(title.id) || !isTitleRow(title)) return;
      let removed = 0;
      const headers: string[] = [];
      for (const row of rows.slice(at + 1)) {
        if (isTitleRow(row)) break;
        if (grouped.has(row.id) || row.cells.some((cell) => filledBlocks.has(cell.id))) return;
        if (clears.has(row.id)) removed++;
        else if (isHeaderRow(row)) headers.push(row.id);
        else if (row.cells.some((cell) => cell.text.trim())) return;
      }
      if (removed === 0) return;
      clears.add(title.id);
      for (const id of headers) clears.add(id);
    });
  }

  // --- 3. completeness ---
  const additional: string[] = [];
  const groupSections = new Set(groups.map((group) => group.source));
  if (content.summary && !placed.has("summary")) additional.push("summary");
  content.sections.forEach((section, s) => {
    if (groupSections.has(`s${s}`)) return;
    section.entries.forEach((entry, e) => {
      if (!hasEntryContent(entry)) return;
      const ref = entryRef(s, e);
      if (placed.has(ref)) return;
      const fields = placedFields.get(ref);
      if (!fields) {
        additional.push(ref);
        return;
      }
      // Partly shown entry: its missing short details (dates, location,
      // employer) join the entry's own last line; longer text goes to the end.
      const owner = [...fills]
        .reverse()
        .find((fill) => fill.refs.some((r) => r !== null && r.includes(`${ref}.`)));
      for (const field of leftoverFields(entry, fields)) {
        const short = ["heading", "subheading", "location", "dates", "startDate", "endDate"];
        if (owner && short.includes(field)) {
          const at = owner.refs.findLastIndex((r) => r !== null && r.includes(`${ref}.`));
          // A name or place goes before the line's dates ("Degree, School, 2009 – 2015").
          const parts = refParts(owner.refs[at]!);
          const datesAt = parts.findIndex((part) => /\.(?:dates|startDate|endDate)$/.test(part));
          const isDate = /^(?:dates|startDate|endDate)$/.test(field);
          if (datesAt !== -1 && !isDate) parts.splice(datesAt, 0, `${ref}.${field}`);
          else parts.push(`${ref}.${field}`);
          owner.refs[at] = parts.join("+");
        } else {
          additional.push(`${ref}.${field}`);
        }
      }
    });
  });
  if (additional.length > 0) {
    const titles = new Set(
      additional.map((ref) => {
        const resolved = /^s(\d+)/.exec(ref);
        return resolved ? content.sections[Number(resolved[1])]!.title : "Summary";
      }),
    );
    for (const ref of additional) {
      if (/^s\d+\.e\d+$/.test(ref) || ref === "summary")
        issues.push(`Content "${ref}" is not placed in any block.`);
    }
    warnings.push(
      `Content the template has no place for (${[...titles].join(", ")}) was added under "Additional Information" at the end.`,
    );
  }

  // --- 4. contact details ---
  const hidden = presentContactFields(content).filter(
    (field) => field !== "fullName" && !contactShown.has(field),
  );
  if (hidden.length > 0) {
    warnings.push(
      `Contact details the template has no place for were left out (${hidden.map((field) => CONTACT_LABELS[field]).join(", ")}).`,
    );
  }
  const insertName = !contactShown.has("fullName");
  if (insertName) {
    issues.push(
      `No block is filled with "contact.fullName"; if the template has a name line, fill it (never a section heading).`,
    );
    warnings.push("The template has no name line, so the candidate's name was added at the top.");
  }

  return {
    plan: {
      ...aiPlan,
      engine: "fill",
      fills,
      keeps,
      clears: [...clears],
      groups,
      additional,
      hiddenContactFields: hidden,
      insertName,
      bulletSections: [],
      bulletSummary: false,
      source,
    },
    issues,
    warnings,
  };
}

/**
 * The template analysis lists "placeholders": sometimes the sample person's
 * values ("Lauren Wentworth"), often just field labels ("Name:", column
 * headers). Only the values are evidence of sample content.
 */
export function sampleValues(placeholders: readonly string[]): string[] {
  return placeholders
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(
      (text) =>
        text.length >= 4 &&
        !/^\[.*\]$/.test(text) &&
        !text.includes(" | ") &&
        !isLabelLike(text, false) &&
        // The heading the filler itself adds for content without a place.
        !/^additional information$/i.test(text),
    );
}

const CONTACT_LABELS: Record<string, string> = {
  headline: "job title",
  email: "email",
  phone: "phone",
  location: "location",
  links: "links",
};

/** Entry fields with a value that no direct fill has shown. */
function leftoverFields(
  entry: ResumeContent["sections"][number]["entries"][number],
  shown: Set<string>,
) {
  const fields: string[] = [];
  const scalar = (field: "heading" | "subheading" | "location") => {
    if (entry[field] && !shown.has(field)) fields.push(field);
  };
  scalar("heading");
  scalar("subheading");
  scalar("location");
  // Showing either date counts as showing the entry's dates (a "Completed" column
  // shows the end year; the start date does not need a place of its own).
  const datesShown = shown.has("dates") || shown.has("startDate") || shown.has("endDate");
  // Leftover dates read as one range ("Feb 2009 – 2015"), not two lines.
  if (!datesShown && (entry.startDate || entry.endDate)) {
    if (entry.startDate && entry.endDate) fields.push("dates");
    else fields.push(entry.startDate ? "startDate" : "endDate");
  }
  const textShown = shown.has("text");
  if (entry.description && !textShown && !shown.has("description")) fields.push("description");
  if (
    entry.bullets.some((b) => b.trim()) &&
    !textShown &&
    !shown.has("bullets") &&
    !shown.has("item")
  ) {
    fields.push("bullets");
  }
  return fields;
}

/**
 * The resume as the fill plan shows it: contact details the template has no
 * place for are removed, so the filler and the validator agree on what the
 * document must contain. The name always stays.
 */
export function contentShownByFillPlan(
  content: ResumeContent,
  plan: Pick<FillPlan, "hiddenContactFields">,
): ResumeContent {
  const hidden = new Set(plan.hiddenContactFields);
  const { contact } = content;
  return {
    ...content,
    contact: {
      fullName: contact.fullName,
      ...(!hidden.has("headline") && contact.headline ? { headline: contact.headline } : {}),
      ...(!hidden.has("email") && contact.email ? { email: contact.email } : {}),
      ...(!hidden.has("phone") && contact.phone ? { phone: contact.phone } : {}),
      ...(!hidden.has("location") && contact.location ? { location: contact.location } : {}),
      links: hidden.has("links") ? [] : contact.links,
    },
  };
}

const normHeading = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A one-cell row in capitals ("ADDITIONAL SKILLS, …") that heads the rows after it. */
function isTitleRow(row: RowInfo): boolean {
  if (row.cells.length !== 1) return false;
  const letters = row.cells[0]!.text.replace(/[^\p{L}]/gu, "");
  const capitals = letters.replace(/[^\p{Lu}]/gu, "");
  return letters.length >= 4 && capitals.length / letters.length > 0.85;
}

/**
 * The plan without anything it puts under the named headings of the template
 * (the person asked to remove "the additional skills section" they see in the
 * Word file): the blocks under such a heading are left unplanned, so the
 * engine clears them and the heading with them.
 */
export function withoutHeadings(
  plan: AIFillPlan,
  blocks: BlockInfo[],
  headings: readonly string[],
): AIFillPlan {
  const wanted = headings.map(normHeading).filter((text) => text.length >= 4);
  if (wanted.length === 0) return plan;
  const matches = (text: string) => {
    const own = normHeading(text);
    return (
      own.length >= 4 &&
      wanted.some((heading) => own === heading || (own.length >= 8 && heading.includes(own)))
    );
  };
  const region = new Set<string>(); // paragraph, row and cell ids under the headings
  const addRow = (row: RowInfo) => {
    region.add(row.id);
    for (const cell of row.cells) region.add(cell.id);
  };
  blocks.forEach((block, index) => {
    if (block.kind === "paragraph") {
      if (!matches(block.text)) return;
      region.add(block.id);
      for (const next of blocks.slice(index + 1)) {
        if (next.kind === "paragraph" ? isHeadingLike(next) : next.rows.some(isTitleRow)) break;
        if (next.kind === "paragraph") region.add(next.id);
        else next.rows.forEach(addRow);
      }
      return;
    }
    next: for (const [at, row] of block.rows.entries()) {
      if (!row.cells.some((cell) => matches(cell.text))) continue;
      addRow(row);
      for (const following of block.rows.slice(at + 1)) {
        if (isTitleRow(following)) break next;
        addRow(following);
      }
      break;
    }
  });
  if (region.size === 0) return plan;
  const inRegion = (id: string) =>
    region.has(id) ||
    [...region].some((entry) => id.startsWith(`${entry}.`) && entry.includes(".r"));
  return {
    ...plan,
    fills: plan.fills.filter((fill) => !inRegion(fill.block)),
    groups: plan.groups.filter((group) => !inRegion(group.blocks[0] ?? group.rows[0] ?? "")),
    keeps: plan.keeps.filter((id) => !inRegion(id)),
  };
}
