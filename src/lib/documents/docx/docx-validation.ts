import "server-only";

import JSZip from "jszip";

import type { ResumeContent } from "../resume-content";
import { comparable, isSafeWebUrl, toParagraphs } from "./text";

/*
 * Checks a generated DOCX before it is presented as a result: it must be a
 * readable Word package, and every piece of resume content must be present
 * in the document text. Hyperlink targets must be the resume's own links
 * (and web/mailto only).
 */

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"];
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
/** A generated resume is a few dozen KB; anything near this indicates a bug. */
export const MAX_GENERATED_DOCX_BYTES = 10 * 1024 * 1024;

export interface DocxValidationResult {
  ok: boolean;
  /** Internal descriptions (no resume text): e.g. "missing part word/document.xml", "missing 3 text items". */
  problems: string[];
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

/** Plain text of document.xml: runs joined within a paragraph, paragraphs by newlines. */
export function documentXmlText(xml: string): string {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs
    .map((paragraph) =>
      (paragraph.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>/g) ?? [])
        .map((token) => (token === "<w:tab/>" ? " " : decodeXml(token.replace(/<[^>]+>/g, ""))))
        .join(""),
    )
    .join("\n");
}

/** Every text item from the resume that must appear in the document. */
export function expectedTexts(content: ResumeContent): string[] {
  const { contact } = content;
  const texts = [
    contact.fullName,
    contact.headline,
    contact.email,
    contact.phone,
    contact.location,
  ];
  texts.push(...toParagraphs(content.summary));
  for (const section of content.sections) {
    for (const entry of section.entries) {
      texts.push(entry.heading, entry.subheading, entry.location, entry.startDate, entry.endDate);
      texts.push(...toParagraphs(entry.description), ...entry.bullets);
    }
  }
  return [
    ...new Set(
      texts
        .filter((text): text is string => typeof text === "string")
        .map(comparable)
        .filter(Boolean),
    ),
  ];
}

export interface DocxValidationOptions {
  /**
   * generated: a document our renderer built (layout rules apply);
   * filled: a copy of the client's own template (its page setup, sizes and
   * spacing are the client's choice and are not judged).
   */
  mode?: "generated" | "filled";
  /** Template texts that must not survive (the sample candidate's name and values). */
  forbiddenTexts?: string[];
}

export async function validateDocx(
  data: Uint8Array,
  content: ResumeContent,
  options: DocxValidationOptions = {},
): Promise<DocxValidationResult> {
  const filled = options.mode === "filled";
  const problems: string[] = [];
  if (data.length === 0) return { ok: false, problems: ["empty file"] };
  if (data.length > MAX_GENERATED_DOCX_BYTES) return { ok: false, problems: ["file too large"] };
  if (data[0] !== 0x50 || data[1] !== 0x4b) return { ok: false, problems: ["not a ZIP package"] };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return { ok: false, problems: ["unreadable ZIP package"] };
  }
  for (const part of REQUIRED_PARTS) {
    if (!zip.file(part)) problems.push(`missing part ${part}`);
  }
  if (problems.length) return { ok: false, problems };

  let total = 0;
  for (const file of Object.values(zip.files)) {
    // Uncompressed size from the central directory (internal field; best effort).
    total +=
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (total > MAX_UNCOMPRESSED_BYTES) return { ok: false, problems: ["package too large"] };

  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  if (!contentTypes.includes("wordprocessingml.document.main+xml")) {
    problems.push("not a Word document");
  }
  const xml = await zip.file("word/document.xml")!.async("string");
  if (!/<w:body>/.test(xml)) problems.push("document has no body");

  const text = comparable(documentXmlText(xml));
  const missing = expectedTexts(content).filter((expected) => !text.includes(expected));
  if (missing.length) problems.push(`missing ${missing.length} text item(s)`);

  // Nothing of the template's sample candidate may survive, in any part.
  if (options.forbiddenTexts?.length) {
    const parts = Object.keys(zip.files).filter((name) =>
      /^word\/(?:header|footer)\d*\.xml$/.test(name),
    );
    let everywhere = text;
    for (const part of parts) {
      everywhere += `\n${comparable(documentXmlText(await zip.file(part)!.async("string")))}`;
    }
    const leftover = options.forbiddenTexts
      .map(comparable)
      .filter((forbidden) => forbidden && everywhere.includes(forbidden));
    if (leftover.length) problems.push(`template sample text left in (${leftover.length})`);
  }

  // Hyperlinks: only the resume's own links (plus mailto for its email), web/mailto only.
  const rels = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const targets = [...rels.matchAll(/Target="([^"]*)"\s+TargetMode="External"/g)].map((m) =>
    decodeXml(m[1]!),
  );
  const allowed = new Set(content.contact.links.map((link) => link.url));
  if (content.contact.email) allowed.add(`mailto:${content.contact.email}`);
  for (const target of targets) {
    const safe = target.startsWith("mailto:") || isSafeWebUrl(target);
    if (!safe || !allowed.has(target)) problems.push("unexpected hyperlink target");
  }
  const expectedLinks = content.contact.links.filter((link) => isSafeWebUrl(link.url));
  if (expectedLinks.some((link) => !targets.includes(link.url))) problems.push("missing hyperlink");

  const styles = (await zip.file("word/styles.xml")?.async("string")) ?? "";
  problems.push(...structuralProblems(xml, rels, styles, { layout: !filled }));

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** Smallest run size allowed anywhere (half-points): 8 pt, used only for footers. */
const MIN_RUN_HALF_POINTS = 16;
const MARGIN_TWIPS = { min: 576, max: 2160 }; // 0.4–1.5 in

/**
 * Layout/structure checks that a text comparison cannot see: well-formed
 * XML, consistent tables, resolvable hyperlinks, readable sizes, sane
 * margins, and nothing that produces blank pages or long blank stretches.
 */
export function structuralProblems(
  xml: string,
  rels: string,
  styles = "",
  { layout = true }: { layout?: boolean } = {},
): string[] {
  const problems: string[] = [];

  // Well-formed element nesting.
  const stack: string[] = [];
  for (const [, closing, name, , selfClosing] of xml.matchAll(
    /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g,
  )) {
    if (selfClosing) continue;
    if (!closing) stack.push(name!);
    else if (stack.pop() !== name) {
      problems.push("malformed XML");
      break;
    }
  }
  if (stack.length > 0 && !problems.includes("malformed XML")) problems.push("malformed XML");

  // Tables we generate: no nesting, and every row has one cell per grid
  // column. A filled client template keeps its own tables as they are (Word
  // accepts ragged rows and nested tables), so they are not judged here.
  const tables = layout ? xml.split("<w:tbl>").slice(1) : [];
  for (const table of tables) {
    const body = table.split("</w:tbl>")[0]!;
    if (table.indexOf("</w:tbl>") === -1) continue;
    const columns = (body.match(/<w:gridCol\b/g) ?? []).length;
    const rows = body.split(/<w:tr[ >]/).slice(1);
    if (columns === 0 || rows.length === 0) problems.push("broken table");
    for (const row of rows) {
      // Each row must cover every grid column (a merged cell spans several).
      const cells = row.split(/<w:tc[ >]/).slice(1);
      const covered = cells.reduce((sum, cell) => {
        const properties = /^[\s\S]*?<\/w:tcPr>/.exec(cell)?.[0] ?? "";
        return sum + Number(/<w:gridSpan w:val="(\d+)"/.exec(properties)?.[1] ?? 1);
      }, 0);
      if (covered !== columns) problems.push("broken table");
    }
  }
  if (layout && /<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*<w:tbl>/.test(xml)) problems.push("nested table");

  // Every hyperlink points at an existing relationship.
  const relIds = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of xml.matchAll(/<w:hyperlink[^>]*r:id="([^"]+)"/g)) {
    if (!relIds.has(id)) problems.push("broken hyperlink");
  }

  if (!layout) return problems;

  // Readable sizes and sane margins.
  for (const [, size] of (xml + styles).matchAll(/<w:sz w:val="(\d+)"/g)) {
    if (Number(size) < MIN_RUN_HALF_POINTS) problems.push("unreadably small text");
  }
  const margins = /<w:pgMar ([^>]*)\/>/.exec(xml)?.[1] ?? "";
  for (const side of ["top", "right", "bottom", "left"]) {
    const value = Number(new RegExp(`w:${side}="(\\d+)"`).exec(margins)?.[1]);
    if (!(value >= MARGIN_TWIPS.min && value <= MARGIN_TWIPS.max)) problems.push("unusual margins");
  }

  // Blank pages / blank space.
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  if (/<w:br w:type="page"\/>/.test(xml)) problems.push("manual page break");
  let previousBreak = false;
  let emptyRun = 0;
  paragraphs.forEach((paragraph, index) => {
    const breaks = paragraph.includes("<w:pageBreakBefore/>");
    if (breaks && (index === 0 || previousBreak)) problems.push("blank page");
    previousBreak = breaks;
    const empty = !/<w:t[ >]|<w:tab\/>/.test(paragraph);
    emptyRun = empty ? emptyRun + 1 : 0;
    if (emptyRun > 2) problems.push("blank space");
  });

  return problems;
}
