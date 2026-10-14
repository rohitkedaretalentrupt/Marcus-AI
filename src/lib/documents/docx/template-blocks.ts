import { stripInvalidChars } from "./text";

/*
 * Addressable blocks of a DOCX template body (word/document.xml), parsed
 * from and serialised back to WordprocessingML without an XML library:
 *
 *   p12          a body paragraph (style, numbering, bold and tab stops kept)
 *   t0           a table; t0.r1 its second row; t0.r1.c0 that row's first cell
 *
 * The fill engine edits these blocks in place: text is written into the
 * first run of a paragraph (so the run's font, size, bold… stay), repeat
 * groups are cloned per resume entry, and leftover sample blocks are removed.
 * Everything that is not a paragraph, table, row or cell (section
 * properties, bookmarks, content controls, …) is kept verbatim and is not
 * addressable. Text written into the document is always XML-escaped here.
 */

export interface TextAtom {
  kind: "text";
  rPr: string;
  text: string;
  /** Written as a hyperlink to this (already checked) web URL. */
  href?: string;
}

/** Relationship id for a hyperlink target, supplied by the package writer. */
export type LinkRelation = (url: string) => string;
export interface TabAtom {
  kind: "tab";
  rPr: string;
}
export interface BreakAtom {
  kind: "break";
  rPr: string;
}
/** A whole run (drawing, field, symbol, …) or a non-run child, kept verbatim. */
export interface OtherAtom {
  kind: "other";
  xml: string;
}
export type Atom = TextAtom | TabAtom | BreakAtom | OtherAtom;

export interface ParagraphNode {
  kind: "paragraph";
  id: string;
  /** Attributes of <w:p>, without revision/paragraph ids (cloned paragraphs must not share them). */
  attrs: string;
  pPr: string;
  atoms: Atom[];
}

export interface CellNode {
  kind: "cell";
  id: string;
  tcPr: string;
  /** Cell content: paragraphs plus anything else (a nested table makes the cell opaque). */
  children: (ParagraphNode | OtherNode)[];
  opaque: boolean;
}

export interface RowNode {
  kind: "row";
  id: string;
  attrs: string;
  prefix: string;
  children: (CellNode | OtherNode)[];
}

export interface TableNode {
  kind: "table";
  id: string;
  attrs: string;
  /** tblPr + tblGrid (and anything else before the first row). */
  prefix: string;
  children: (RowNode | OtherNode)[];
}

export interface OtherNode {
  kind: "other";
  xml: string;
}

export type BodyNode = ParagraphNode | TableNode | OtherNode;

export interface TemplateBody {
  /** Attributes of <w:body> (normally none). */
  attrs: string;
  nodes: BodyNode[];
  /** The final <w:sectPr> (page setup), kept at the end. */
  sectPr: string;
}

// --- XML scanning ---------------------------------------------------------------

interface Element {
  name: string;
  attrs: string;
  /** Inner XML (empty for self-closing elements). */
  inner: string;
  xml: string;
}

const TAG =
  /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;

/** Top-level child elements of an XML fragment (text between them is dropped). */
export function childElements(xml: string): Element[] {
  const elements: Element[] = [];
  let depth = 0;
  let start = 0;
  let name = "";
  let attrs = "";
  let innerStart = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(xml); match; match = TAG.exec(xml)) {
    const [token, closing, tagName, tagAttrs, selfClosing] = match;
    if (tagName === undefined) continue; // comment, CDATA, processing instruction
    if (closing) {
      depth--;
      if (depth === 0) {
        elements.push({
          name,
          attrs,
          inner: xml.slice(innerStart, match.index),
          xml: xml.slice(start, match.index + token.length),
        });
      }
      continue;
    }
    if (depth === 0) {
      start = match.index;
      name = tagName;
      attrs = tagAttrs ?? "";
      innerStart = match.index + token.length;
      if (selfClosing) {
        elements.push({ name, attrs, inner: "", xml: token });
        continue;
      }
    }
    if (!selfClosing) depth++;
  }
  return elements;
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

export const escapeXml = (text: string) =>
  stripInvalidChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Attributes without paragraph/revision ids, which must be unique per paragraph. */
const stripIds = (attrs: string) =>
  attrs.replace(/\s+(?:w14:paraId|w14:textId|w:rsid\w*)="[^"]*"/g, "");

// --- paragraphs --------------------------------------------------------------------

function runAtoms(run: Element): Atom[] {
  const atoms: Atom[] = [];
  let rPr = "";
  const others: string[] = [];
  for (const child of childElements(run.inner)) {
    if (child.name === "w:rPr") rPr = child.xml;
    else if (child.name === "w:t") atoms.push({ kind: "text", rPr, text: decodeXml(child.inner) });
    else if (child.name === "w:tab") atoms.push({ kind: "tab", rPr });
    else if (child.name === "w:br" && /w:type="(?:page|column)"/.test(child.attrs))
      others.push(child.xml);
    else if (child.name === "w:br" || child.name === "w:cr") atoms.push({ kind: "break", rPr });
    else if (child.name === "w:lastRenderedPageBreak") continue;
    else others.push(child.xml);
  }
  // Text atoms parsed before the rPr (never in practice) get it now.
  for (const atom of atoms) if (atom.kind !== "other" && !atom.rPr) atom.rPr = rPr;
  if (others.length)
    atoms.push({ kind: "other", xml: `<w:r${run.attrs}>${rPr}${others.join("")}</w:r>` });
  return atoms;
}

/** Runs inside hyperlinks, insertions and smart tags count as the paragraph's own. */
const RUN_WRAPPERS = new Set([
  "w:hyperlink",
  "w:ins",
  "w:smartTag",
  "w:customXml",
  "w:dir",
  "w:bdo",
]);

function contentAtoms(inner: string): Atom[] {
  const atoms: Atom[] = [];
  for (const child of childElements(inner)) {
    if (child.name === "w:r") atoms.push(...runAtoms(child));
    else if (RUN_WRAPPERS.has(child.name)) atoms.push(...contentAtoms(child.inner));
    else if (child.name === "w:proofErr" || child.name === "w:del") continue;
    else atoms.push({ kind: "other", xml: child.xml });
  }
  return atoms;
}

function parseParagraph(element: Element, id: string): ParagraphNode {
  let pPr = "";
  const rest: string[] = [];
  for (const child of childElements(element.inner)) {
    if (child.name === "w:pPr" && !pPr) pPr = child.xml;
    else rest.push(child.xml);
  }
  return {
    kind: "paragraph",
    id,
    attrs: stripIds(element.attrs),
    pPr,
    atoms: contentAtoms(rest.join("")),
  };
}

/** Elements that follow <w:spacing> inside <w:pPr> (schema order). */
const AFTER_SPACING =
  /<w:(?:ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;

/** Paragraph properties with no space before and/or after (for lines split from one paragraph). */
function tightSpacing(pPr: string, before: boolean, after: boolean): string {
  if (!before && !after) return pPr;
  const set = (spacing: string, name: string) =>
    new RegExp(`\\sw:${name}="[^"]*"`).test(spacing)
      ? spacing.replace(
          new RegExp(`(\\sw:${name}=")[^"]*"`),
          (_match, start: string) => `${start}0"`,
        )
      : spacing.replace("<w:spacing", `<w:spacing w:${name}="0"`);
  // (Not a run's character spacing inside <w:rPr>.)
  const existing = /<w:spacing\b[^>]*\/>/.exec(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""))?.[0];
  if (existing) {
    let spacing = existing;
    if (before) spacing = set(spacing, "before");
    if (after) spacing = set(spacing, "after");
    return pPr.replace(existing, spacing);
  }
  const spacing = `<w:spacing${before ? ' w:before="0"' : ""}${after ? ' w:after="0"' : ""}/>`;
  if (!pPr) return `<w:pPr>${spacing}</w:pPr>`;
  const at = pPr.search(AFTER_SPACING);
  return at === -1
    ? pPr.replace("</w:pPr>", `${spacing}</w:pPr>`)
    : `${pPr.slice(0, at)}${spacing}${pPr.slice(at)}`;
}

const SECTION_BREAK = /<w:sectPr\b[^>]*\/>|<w:sectPr\b[\s\S]*?<\/w:sectPr>/;

/** The section break (<w:sectPr>) a paragraph ends, if any. */
export function sectionBreakOf(paragraph: ParagraphNode): string | null {
  return SECTION_BREAK.exec(paragraph.pPr)?.[0] ?? null;
}

/** The paragraph without the section break it ends. */
export function withoutSectionBreak(paragraph: ParagraphNode): ParagraphNode {
  return { ...paragraph, pPr: paragraph.pPr.replace(SECTION_BREAK, "") };
}

/** The paragraph ending the given section (<w:sectPr> goes after rPr, before pPrChange). */
export function withSectionBreak(paragraph: ParagraphNode, sectPr: string): ParagraphNode {
  const pPr = paragraph.pPr || "<w:pPr></w:pPr>";
  const at = pPr.indexOf("<w:pPrChange");
  return {
    ...paragraph,
    pPr:
      at === -1
        ? pPr.replace("</w:pPr>", sectPr + "</w:pPr>")
        : pPr.slice(0, at) + sectPr + pPr.slice(at),
  };
}

/** Lines split from one paragraph: only the last still ends its section. */
function sectionOnLast(lines: ParagraphNode[]): ParagraphNode[] {
  return lines.map((line, index) => (index < lines.length - 1 ? withoutSectionBreak(line) : line));
}

/**
 * One paragraph per line: a (non-list) paragraph whose lines are separated
 * by manual line breaks ("Name<br/>Location: …", "EXPERIENCE<br/>Employer…")
 * becomes one paragraph per line, so each line can be addressed on its own.
 * The lines keep the paragraph's properties, without space between them.
 */
function splitLines(paragraph: ParagraphNode, nextId: () => string): ParagraphNode[] {
  if (!paragraph.atoms.some((atom) => atom.kind === "break")) {
    return [{ ...paragraph, id: nextId() }];
  }
  const lines: Atom[][] = [[]];
  for (const atom of paragraph.atoms) {
    if (atom.kind === "break") lines.push([]);
    else lines.at(-1)!.push(atom);
  }
  const hasText = (atoms: Atom[]) =>
    atoms.some((atom) => (atom.kind === "text" && atom.text.trim()) || atom.kind === "other");
  const kept = lines.filter(hasText);
  if (kept.length <= 1) return [{ ...paragraph, id: nextId() }];

  if (isNumbered(paragraph)) {
    // A list item keeps its extra lines — unless a later line is a heading
    // run into it ("…last summary bullet.<br/>Skills:"): that heading becomes
    // its own paragraph, without the bullet.
    const lineText = (atoms: Atom[]) =>
      atoms
        .map((atom) => (atom.kind === "text" ? atom.text : ""))
        .join("")
        .trim();
    const at = kept.findIndex(
      (atoms, index) =>
        index > 0 && isLabelLike(lineText(atoms), false) && !inlineLabel(lineText(atoms)),
    );
    if (at === -1) return [{ ...paragraph, id: nextId() }];
    const item: ParagraphNode = {
      ...paragraph,
      id: nextId(),
      atoms: kept
        .slice(0, at)
        .flatMap((atoms, index) =>
          index ? [{ kind: "break", rPr: "" } as Atom, ...atoms] : atoms,
        ),
    };
    const plain = withoutNumbering(paragraph.pPr);
    const rest = kept.slice(at).map((atoms) => ({
      ...paragraph,
      id: nextId(),
      pPr: plain,
      atoms,
    }));
    return sectionOnLast([item, ...rest]);
  }

  return sectionOnLast(
    kept.map((atoms, index) => ({
      ...paragraph,
      id: nextId(),
      pPr: tightSpacing(paragraph.pPr, index > 0, index < kept.length - 1),
      atoms,
    })),
  );
}

function serializeAtom(atom: Atom, link?: LinkRelation): string {
  switch (atom.kind) {
    case "text": {
      const run = `<w:r>${atom.rPr}<w:t xml:space="preserve">${escapeXml(atom.text)}</w:t></w:r>`;
      return atom.href && link
        ? `<w:hyperlink r:id="${escapeXml(link(atom.href))}">${run}</w:hyperlink>`
        : run;
    }
    case "tab":
      return `<w:r>${atom.rPr}<w:tab/></w:r>`;
    case "break":
      return `<w:r>${atom.rPr}<w:br/></w:r>`;
    case "other":
      return atom.xml;
  }
}

export function serializeParagraph(paragraph: ParagraphNode, link?: LinkRelation): string {
  const atoms = paragraph.atoms.map((atom) => serializeAtom(atom, link)).join("");
  return `<w:p${paragraph.attrs}>${paragraph.pPr}${atoms}</w:p>`;
}

/** Plain text of a paragraph (tabs as "\t"; breaks as newlines). */
export function paragraphText(paragraph: ParagraphNode): string {
  return paragraph.atoms
    .map((atom) => {
      if (atom.kind === "text") return atom.text;
      if (atom.kind === "tab") return "\t";
      if (atom.kind === "break") return "\n";
      return otherText(atom.xml);
    })
    .join("");
}

/** Text inside verbatim XML (content controls, fields, …). */
function otherText(xml: string): string {
  return (xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? [])
    .map((t) => decodeXml(t.replace(/<[^>]+>/g, "")))
    .join("");
}

/** A list style that brings its own bullet or number ("ListBullet", "List Number 2"). */
const LIST_STYLE = /<w:pStyle w:val="List ?(?:Bullet|Number)\d*"\s*\/>/i;

/** A list item: numbered directly or through a list paragraph style. */
export const isNumbered = (paragraph: ParagraphNode) =>
  /<w:numPr>/.test(paragraph.pPr) || LIST_STYLE.test(paragraph.pPr);

/** Paragraph properties without list numbering (bullet or number, and its indent). */
export function withoutNumbering(pPr: string): string {
  return pPr
    .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, "")
    .replace(LIST_STYLE, "")
    .replace(/<w:ind\b[^>]*\/>/, "");
}

/** Bold when every text run says so (or the paragraph style is a heading). */
export function isBold(paragraph: ParagraphNode): boolean {
  const texts = paragraph.atoms.filter(
    (atom): atom is TextAtom => atom.kind === "text" && atom.text.trim().length > 0,
  );
  if (texts.length === 0) return /<w:pStyle w:val="Heading/.test(paragraph.pPr);
  return texts.every((atom) => /<w:b\b(?![^>]*w:val="(?:0|false)")/.test(atom.rPr));
}

export const paragraphStyle = (paragraph: ParagraphNode) =>
  /<w:pStyle w:val="([^"]+)"/.exec(paragraph.pPr)?.[1];

/**
 * Tab-separated parts of a paragraph with visible text, e.g. an employer
 * line "Contoso<tab>2019 – 2021" has the segments ["Contoso", "2019 – 2021"].
 * Returned with the atom index range each one covers.
 */
export function paragraphSegments(
  paragraph: ParagraphNode,
): { text: string; from: number; to: number }[] {
  const segments: { text: string; from: number; to: number }[] = [];
  let from = 0;
  const flush = (to: number) => {
    const text = paragraph.atoms
      .slice(from, to)
      .map((atom) => (atom.kind === "text" ? atom.text : ""))
      .join("")
      .trim();
    if (text) segments.push({ text, from, to });
    from = to + 1;
  };
  paragraph.atoms.forEach((atom, index) => {
    if (atom.kind === "tab") flush(index);
  });
  flush(paragraph.atoms.length);
  return segments;
}

/** The run properties new text in this paragraph should use. */
function defaultRunProperties(paragraph: ParagraphNode): string {
  const first = paragraph.atoms.find((atom): atom is TextAtom => atom.kind === "text");
  if (first) return first.rPr;
  const mark = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(paragraph.pPr)?.[0];
  return mark ?? "";
}

/**
 * Writes text into a paragraph, one value per visible segment (null leaves
 * a segment as it is). The first text run of a segment keeps its properties
 * and receives the value; the segment's other text runs are removed; tabs
 * stay so the following segments keep their positions. Verbatim content that
 * carries text (fields, content controls) is removed too, so no sample text
 * survives. An empty paragraph gets the value as a new run.
 */
export function writeParagraph(paragraph: ParagraphNode, values: (string | null)[]): ParagraphNode {
  const segments = paragraphSegments(paragraph);
  const atoms: Atom[] = paragraph.atoms.map((atom) => ({ ...atom }));
  const drop = new Set<number>();
  /** Writes `value` into atoms [from, to); returns false if there was no text run. */
  const write = (from: number, to: number, value: string) => {
    let written = false;
    const texts = atoms
      .slice(from, to)
      .filter((atom): atom is TextAtom => atom.kind === "text" && atom.text.trim().length > 0);
    // A segment led by a label ("**Programming:** Python, …", the label
    // perhaps split over runs) gets the value in the style of its body text,
    // not the label's; so does a bullet that opens with a bold phrase
    // ("**Managed campaigns** for 9+ clients…"): the new sentence is body text.
    const longestOf = (runs: TextAtom[]) =>
      runs.reduce<TextAtom | undefined>(
        (longest, atom) => (!longest || atom.text.length > longest.text.length ? atom : longest),
        undefined,
      );
    const isBoldRun = (atom: TextAtom) => /<w:b\b(?![^>]*w:val="(?:0|false)")/.test(atom.rPr);
    const labelEnd = texts.slice(0, 4).findIndex((atom) => /:\s*$/.test(atom.text));
    const label = texts
      .slice(0, labelEnd + 1)
      .map((atom) => atom.text)
      .join("")
      .trim();
    const afterLabel = longestOf(texts.slice(labelEnd + 1));
    const labelled =
      labelEnd !== -1 &&
      afterLabel !== undefined &&
      label.length <= 60 &&
      texts.slice(labelEnd + 1).reduce((sum, atom) => sum + atom.text.length, 0) > label.length &&
      !value.toLowerCase().startsWith(label.toLowerCase());
    const plainRuns = texts.filter((atom) => !isBoldRun(atom));
    const plainLength = plainRuns.reduce((sum, atom) => sum + atom.text.trim().length, 0);
    const boldLength = texts
      .filter(isBoldRun)
      .reduce((sum, atom) => sum + atom.text.trim().length, 0);
    const boldLead =
      texts[0] !== undefined &&
      isBoldRun(texts[0]) &&
      value.length > 40 &&
      plainLength > 2 * boldLength;
    const target = labelled
      ? afterLabel
      : boldLead && labelEnd === -1
        ? longestOf(plainRuns)
        : undefined;
    for (let i = from; i < to; i++) {
      const atom = atoms[i]!;
      if (atom.kind === "text") {
        if (!written) {
          atom.text = value;
          if (target) atom.rPr = target.rPr;
          written = true;
        } else drop.add(i);
      } else if (atom.kind === "break") drop.add(i);
      else if (atom.kind === "other" && otherText(atom.xml)) drop.add(i);
    }
    return written;
  };

  if (segments.length === 0) {
    const value = values.filter((v): v is string => v !== null).join(" ");
    if (values.length > 0 && values[0] !== null) {
      const tab = atoms.findIndex((atom) => atom.kind === "tab");
      const to = tab === -1 ? atoms.length : tab;
      if (!write(0, to, value)) {
        atoms.splice(0, 0, { kind: "text", rPr: defaultRunProperties(paragraph), text: value });
        // Indices after the insertion moved by one.
        const moved = new Set([...drop].map((index) => index + 1));
        drop.clear();
        for (const index of moved) drop.add(index);
      }
    }
  } else {
    segments.forEach(({ from, to }, i) => {
      const value = values[i];
      if (value !== null && value !== undefined) write(from, to, value);
    });
    // Values beyond the template's segments are appended to the last one.
    const extra = values
      .slice(segments.length)
      .filter((v): v is string => v !== null && v.length > 0);
    if (extra.length) {
      const last = atoms.findLastIndex((atom, index) => atom.kind === "text" && !drop.has(index));
      if (last >= 0) (atoms[last] as TextAtom).text += ` ${extra.join(" ")}`;
    }
  }
  return { ...paragraph, atoms: atoms.filter((_atom, index) => !drop.has(index)) };
}

/** A copy of the paragraph with no text at all (properties kept). */
export function emptyParagraph(paragraph: ParagraphNode): ParagraphNode {
  return {
    ...paragraph,
    atoms: paragraph.atoms.filter(
      (atom) => atom.kind === "tab" || (atom.kind === "other" && !otherText(atom.xml)),
    ),
  };
}

// --- tables -----------------------------------------------------------------------

function parseCell(element: Element, id: string): CellNode {
  let tcPr = "";
  const children: (ParagraphNode | OtherNode)[] = [];
  let opaque = false;
  let paragraphs = 0;
  for (const child of childElements(element.inner)) {
    if (child.name === "w:tcPr" && !tcPr) tcPr = child.xml;
    else if (child.name === "w:p") {
      children.push(...splitLines(parseParagraph(child, ""), () => `${id}.p${paragraphs++}`));
    } else {
      if (child.name === "w:tbl" || child.name === "w:sdt") opaque = true;
      children.push({ kind: "other", xml: child.xml });
    }
  }
  return { kind: "cell", id, tcPr, children, opaque };
}

function parseRow(element: Element, id: string): RowNode {
  const prefix: string[] = [];
  const children: (CellNode | OtherNode)[] = [];
  let cells = 0;
  for (const child of childElements(element.inner)) {
    if (child.name === "w:tc") children.push(parseCell(child, `${id}.c${cells++}`));
    else if (children.length === 0 && (child.name === "w:trPr" || child.name === "w:tblPrEx")) {
      prefix.push(child.xml);
    } else children.push({ kind: "other", xml: child.xml });
  }
  return { kind: "row", id, attrs: stripIds(element.attrs), prefix: prefix.join(""), children };
}

function parseTable(element: Element, id: string): TableNode {
  const prefix: string[] = [];
  const children: (RowNode | OtherNode)[] = [];
  let rows = 0;
  for (const child of childElements(element.inner)) {
    if (child.name === "w:tr") children.push(parseRow(child, `${id}.r${rows++}`));
    else if (children.length === 0) prefix.push(child.xml);
    else children.push({ kind: "other", xml: child.xml });
  }
  return { kind: "table", id, attrs: element.attrs, prefix: prefix.join(""), children };
}

export const tableRows = (table: TableNode) =>
  table.children.filter((child): child is RowNode => child.kind === "row");
export const rowCells = (row: RowNode) =>
  row.children.filter((child): child is CellNode => child.kind === "cell");
export const cellParagraphs = (cell: CellNode) =>
  cell.children.filter((child): child is ParagraphNode => child.kind === "paragraph");

export function cellText(cell: CellNode): string {
  return cell.children
    .map((child) => (child.kind === "paragraph" ? paragraphText(child) : otherText(child.xml)))
    .join("\n");
}

/** Number of grid columns a cell spans. */
export const cellSpan = (cell: CellNode) =>
  Number(/<w:gridSpan w:val="(\d+)"/.exec(cell.tcPr)?.[1] ?? 1);

function serializeCell(cell: CellNode, link?: LinkRelation): string {
  const inner = cell.children
    .map((child) => (child.kind === "paragraph" ? serializeParagraph(child, link) : child.xml))
    .join("");
  // A cell must end with a paragraph.
  const content =
    /<\/w:p>\s*$/.test(inner) || inner.length === 0 ? inner || "<w:p/>" : `${inner}<w:p/>`;
  return `<w:tc>${cell.tcPr}${content}</w:tc>`;
}

function serializeRow(row: RowNode, link?: LinkRelation): string {
  const cells = row.children
    .map((child) => (child.kind === "cell" ? serializeCell(child, link) : child.xml))
    .join("");
  return `<w:tr${row.attrs}>${row.prefix}${cells}</w:tr>`;
}

function serializeTable(table: TableNode, link?: LinkRelation): string {
  const rows = table.children
    .map((child) => (child.kind === "row" ? serializeRow(child, link) : child.xml))
    .join("");
  return `<w:tbl${table.attrs}>${table.prefix}${rows}</w:tbl>`;
}

// --- body ---------------------------------------------------------------------------

/** Parses word/document.xml into addressable blocks. Throws if there is no body. */
export function parseTemplateBody(documentXml: string): TemplateBody {
  const body = childElements(documentXml)
    .flatMap((root) => childElements(root.inner))
    .find((element) => element.name === "w:body");
  if (!body) throw new Error("document has no body");
  const nodes: BodyNode[] = [];
  let sectPr = "";
  let paragraphs = 0;
  let tables = 0;
  for (const child of childElements(body.inner)) {
    if (child.name === "w:p")
      nodes.push(...splitLines(parseParagraph(child, ""), () => `p${paragraphs++}`));
    else if (child.name === "w:tbl") nodes.push(parseTable(child, `t${tables++}`));
    else if (child.name === "w:sectPr") sectPr = child.xml;
    else nodes.push({ kind: "other", xml: child.xml });
  }
  return { attrs: body.attrs, nodes, sectPr };
}

export function serializeBody(body: TemplateBody, link?: LinkRelation): string {
  const nodes = body.nodes.map((node) => {
    if (node.kind === "paragraph") return serializeParagraph(node, link);
    if (node.kind === "table") return serializeTable(node, link);
    return node.xml;
  });
  return `<w:body${body.attrs}>${nodes.join("")}${body.sectPr}</w:body>`;
}

/** The document XML with its body replaced. */
export function replaceBody(documentXml: string, body: TemplateBody, link?: LinkRelation): string {
  const start = documentXml.search(/<w:body[\s>]/);
  const end = documentXml.lastIndexOf("</w:body>");
  if (start === -1 || end === -1) throw new Error("document has no body");
  return (
    documentXml.slice(0, start) +
    serializeBody(body, link) +
    documentXml.slice(end + "</w:body>".length)
  );
}

// --- descriptions for the AI and the plan checks --------------------------------------

export interface ParagraphInfo {
  kind: "paragraph";
  id: string;
  text: string;
  /** Tab-separated visible parts (one entry when there are no tabs). */
  segments: string[];
  bold: boolean;
  numbered: boolean;
  empty: boolean;
  style?: string;
  align?: string;
  /** Ends a section (e.g. the switch to a two-column list that follows). */
  sectionEnd?: boolean;
}

export interface CellInfo {
  kind: "cell";
  id: string;
  text: string;
  opaque: boolean;
  /** The cell's first line with text is bold (a label or column header). */
  bold: boolean;
}

export interface RowInfo {
  id: string;
  cells: CellInfo[];
  /** Grid columns covered by the row's cells. */
  span: number;
}

export interface TableInfo {
  kind: "table";
  id: string;
  rows: RowInfo[];
}

export type BlockInfo = ParagraphInfo | TableInfo;

export function describeParagraph(paragraph: ParagraphNode): ParagraphInfo {
  const text = paragraphText(paragraph).replace(/\s+/g, " ").trim();
  const align = /<w:jc w:val="([^"]+)"/.exec(paragraph.pPr)?.[1];
  return {
    kind: "paragraph",
    id: paragraph.id,
    text,
    segments: paragraphSegments(paragraph).map((segment) => segment.text),
    bold: isBold(paragraph),
    numbered: isNumbered(paragraph),
    empty: text.length === 0,
    ...(paragraphStyle(paragraph) ? { style: paragraphStyle(paragraph) } : {}),
    ...(align ? { align } : {}),
    ...(sectionBreakOf(paragraph) ? { sectionEnd: true } : {}),
  };
}

export function describeBlocks(body: TemplateBody): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  for (const node of body.nodes) {
    if (node.kind === "paragraph") blocks.push(describeParagraph(node));
    else if (node.kind === "table") {
      blocks.push({
        kind: "table",
        id: node.id,
        rows: tableRows(node).map((row) => ({
          id: row.id,
          span: rowCells(row).reduce((sum, cell) => sum + cellSpan(cell), 0),
          cells: rowCells(row).map((cell) => ({
            kind: "cell",
            id: cell.id,
            text: cellText(cell).replace(/\s+/g, " ").trim(),
            opaque: cell.opaque,
            bold: (() => {
              const first = cellParagraphs(cell).find((p) => paragraphText(p).trim());
              return first ? isBold(first) : false;
            })(),
          })),
        })),
      });
    }
  }
  return blocks;
}

/**
 * Static template wording rather than a sample value: a label ending in ":"
 * or "?", an all-caps heading, a short bold label or column header without a
 * year, or a long instruction ("Use this section for…"). Everything else is
 * treated as the sample candidate's content when the plan leaves it alone.
 */
export function isLabelLike(text: string, bold: boolean): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (/[:?]\s*\*?$/.test(value)) return true;
  // An all-caps heading, possibly followed by instructions in brackets:
  // "SUMMARY (Use this section for a candidate summary…)".
  const head = value.replace(/\([^)]*\)?/g, "").trim();
  const letters = head.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 3 && head === head.toUpperCase() && head.length <= 140) return true;
  if (bold && value.length <= 60 && !/\b(?:19|20)\d{2}\b/.test(value)) return true;
  return /^\(.*\)$/.test(value);
}

/** "Location: " in a line "Location: Minot, ND": a short field label before a value. */
export function inlineLabel(text: string | undefined): string | null {
  const match = /^([A-Za-z][\w /&'-]{1,30}:\s+)\S/.exec(text ?? "");
  return match ? match[1]! : null;
}

/**
 * A form field's label ("Location:", "Pay Rate:", "Work Authorization:",
 * "Major:") rather than a label belonging to the sample person's content
 * ("Programming:", "AWS:", "Publications:", "Test Engineer:"). Only form
 * field labels are kept when their value is filled or cleared.
 */
const FIELD_LABEL =
  /\b(?:name|candidate|location|address|city|state|zip|phone|mobile|cell|e-?mail|linked ?in|url|website|portfolio link|title|position|role|headline|summary|profile|objective|overview|comments?|notes?|availab\w*|authori[sz]ation|visa|citizenship|clearance|rate|pay|salary|compensation|start|notice|relocat\w*|interview|submitted|submission|recruiter|supplier|vendor|referr\w*|timestamp|rtr|requisition|req|id|major|minor|degree|school|university|college|institution|graduat\w*|gpa|company|employer|client|dates?|duration|period|years?|experience|skills?|languages?|certifications?|licen[cs]es?|education)\b/i;

export function isFieldLabel(label: string): boolean {
  return FIELD_LABEL.test(label.replace(/:\s*$/, ""));
}

/** Looks like a section heading: bold, not a list item, short, no dates. */
export function isHeadingLike(info: ParagraphInfo): boolean {
  return (
    !info.empty &&
    info.bold &&
    !info.numbered &&
    info.segments.length === 1 &&
    info.text.length <= 80 &&
    !/\b(?:19|20)\d{2}\b/.test(info.text)
  );
}
