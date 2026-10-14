import "server-only";

import JSZip from "jszip";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

import { assertSafeDocxPackage } from "@/lib/documents/docx/package-safety";
import type { TemplateLayoutHints } from "@/lib/templates/layout-hints";

export type { TemplateLayoutHints };

/**
 * Turns a template document into evidence for structure analysis: a line-by-
 * line "layout digest" (sizes, positions, heading/list/table/column markers)
 * plus measurable hints (page size, margins, fonts, sizes, columns). Read-only
 * — the source bytes are never modified.
 */

export interface TemplateLayout {
  /** Plain text (for "no text" detection). */
  text: string;
  /** Annotated lines for the model. */
  digest: string;
  hints: TemplateLayoutHints;
}

const MAX_PAGES = 5;
const MAX_DIGEST_CHARS = 30_000;

function pageSizeFrom(widthPt: number, heightPt: number): TemplateLayoutHints["pageSize"] {
  const [w, h] = [Math.min(widthPt, heightPt), Math.max(widthPt, heightPt)];
  if (Math.abs(w - 612) < 8 && Math.abs(h - 792) < 8) return "letter";
  if (Math.abs(w - 595) < 8 && Math.abs(h - 842) < 8) return "a4";
  return "unknown";
}

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// --- PDF --------------------------------------------------------------------------

interface PdfSegment {
  text: string;
  x: number;
  size: number;
}

interface PdfRow {
  page: number;
  width: number;
  segments: PdfSegment[];
}

/** Approximate right edge of a text segment (Helvetica-like average glyph width). */
const segmentEnd = (segment: PdfSegment) => segment.x + segment.text.length * segment.size * 0.5;

/**
 * Finds a vertical column boundary: an x position (in the 20–65 % band of
 * the page) where, in many rows, text starts after a wide gap or where whole
 * rows start. Returns null for single-column layouts.
 */
function findColumnSplit(rows: PdfRow[]): number | null {
  const candidates: number[] = [];
  for (const { segments, width } of rows) {
    segments.forEach((segment, index) => {
      if (segment.x < width * 0.2 || segment.x > width * 0.65) return;
      const previous = segments[index - 1];
      const startsColumn = !previous || segment.x - segmentEnd(previous) > width * 0.05;
      if (startsColumn) candidates.push(Math.round(segment.x / 10) * 10);
    });
  }
  const split = mostCommon(candidates);
  if (split === undefined) return null;
  const support = candidates.filter((x) => Math.abs(x - split) <= 10).length;
  return support >= 4 && support >= rows.length * 0.3 ? split - 6 : null;
}

export async function pdfTemplateLayout(data: Uint8Array): Promise<TemplateLayout> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const rows: PdfRow[] = [];
    const fonts = new Set<string>();
    let pageSize: TemplateLayoutHints["pageSize"] = "unknown";

    for (let number = 1; number <= Math.min(pdf.numPages, MAX_PAGES); number++) {
      const page = await pdf.getPage(number);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const width = x1 - x0;
      if (number === 1) pageSize = pageSizeFrom(width, y1 - y0);

      const content = await page.getTextContent();
      for (const style of Object.values(content.styles)) {
        if (style.fontFamily && !/^(sans-serif|serif|monospace)$/.test(style.fontFamily)) {
          fonts.add(style.fontFamily);
        }
      }

      // Group text items into visual rows by their baseline.
      const byBaseline = new Map<number, PdfSegment[]>();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const [a, b, , d, e, f] = item.transform as number[];
        const size = Math.round(Math.max(Math.abs(d!), Math.hypot(a!, b!)) * 2) / 2;
        const y = Math.round(f! / 2) * 2;
        const row = byBaseline.get(y) ?? [];
        row.push({ text: item.str, x: Math.round(e!), size });
        byBaseline.set(y, row);
      }
      for (const [, segments] of [...byBaseline.entries()].sort((p, q) => q[0] - p[0])) {
        rows.push({ page: number, width, segments: segments.sort((p, q) => p.x - q.x) });
      }
    }

    const split = findColumnSplit(rows);
    const sizes: number[] = [];
    let leftMargin = Infinity;
    let rightAligned = false;

    /** One digest line for segments that belong together; marks right-aligned text. */
    const describe = (page: number, width: number, segments: PdfSegment[]) => {
      const first = segments[0]!;
      const size = Math.max(...segments.map((segment) => segment.size));
      sizes.push(size);
      leftMargin = Math.min(leftMargin, first.x);
      const parts = segments.map((segment, index) => {
        const previous = segments[index - 1];
        if (previous && segment.x > width * 0.6 && segment.x - segmentEnd(previous) > width * 0.1) {
          rightAligned = true;
          return ` ⟶[right] ${segment.text}`;
        }
        return segment.text;
      });
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      return {
        line: `[p${page} size=${size} x=${first.x}] ${text}`,
        plain: text.replace(" ⟶[right] ", " "),
      };
    };

    const lines: string[] = [];
    const plain: string[] = [];
    const pages = [...new Set(rows.map((row) => row.page))];
    for (const page of pages) {
      const pageRows = rows.filter((row) => row.page === page);
      const width = pageRows[0]!.width;
      if (split === null) {
        for (const row of pageRows) {
          const { line, plain: text } = describe(page, width, row.segments);
          lines.push(line);
          plain.push(text);
        }
        continue;
      }
      // Two columns: emit full-width rows (e.g. the name) first, then each column in reading order.
      const columns: [string[], string[]] = [[], []];
      const fullWidth: string[] = [];
      let columnsStarted = false;
      for (const row of pageRows) {
        const left = row.segments.filter((segment) => segment.x < split);
        const right = row.segments.filter((segment) => segment.x >= split);
        columnsStarted ||= right.length > 0;
        const spansBoth = left.length > 0 && right.length > 0 && segmentEnd(left.at(-1)!) > split;
        // Rows above the first two-column row (e.g. the name banner) are full width.
        if (spansBoth || !columnsStarted) {
          const { line, plain: text } = describe(page, width, row.segments);
          fullWidth.push(line);
          plain.push(text);
          continue;
        }
        for (const [index, part] of [left, right].entries()) {
          if (part.length === 0) continue;
          const { line, plain: text } = describe(page, width, part);
          columns[index as 0 | 1].push(line);
          plain.push(text);
        }
      }
      lines.push(...fullWidth, "[column 1]", ...columns[0], "[column 2]", ...columns[1]);
    }

    const baseSizePt = mostCommon(sizes);
    return {
      text: plain.join("\n"),
      digest: lines.join("\n").slice(0, MAX_DIGEST_CHARS),
      hints: {
        pageSize,
        marginsInches: Number.isFinite(leftMargin)
          ? Math.round((leftMargin / 72) * 10) / 10
          : undefined,
        fonts: [...fonts].slice(0, 10),
        baseSizePt,
        headingSizesPt: [...new Set(sizes.filter((s) => baseSizePt && s > baseSizePt))].sort(
          (a, b) => b - a,
        ),
        twoColumnsLikely: split !== null,
        rightAlignedText: rightAligned,
        hasTables: false,
      },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// --- DOCX -------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

/** HTML fragment → text. Tabs (right-aligned text such as dates) become a marker. */
function decode(html: string, rightTabs: boolean): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? "")
    .replace(/\t+/g, rightTabs ? " ⟶[right] " : " ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

const BLOCK = /<(h[1-6]|p|li)[^>]*>[\s\S]*?<\/\1>/g;

/** One annotated digest line for a mammoth block (heading, bullet, bold, underlined). */
function annotate(block: string, rightTabs: boolean): string | null {
  const tag = /^<(\w+)/.exec(block)![1]!;
  const text = decode(block, rightTabs);
  if (!text) return null;
  if (tag.startsWith("h")) return `[heading ${tag}] ${text}`;
  if (tag === "li") return `[bullet] ${text}`;
  if (/^<p[^>]*>\s*<strong>[\s\S]*<\/strong>\s*<\/p>$/.test(block)) return `[bold] ${text}`;
  if (/^<p[^>]*>\s*<u>[\s\S]*<\/u>\s*<\/p>$/.test(block)) return `[underlined] ${text}`;
  return text;
}

/**
 * Mammoth's semantic HTML → annotated lines. Tables whose cells hold several
 * paragraphs are page-layout tables (a common way to build two-column CVs):
 * their cells are emitted as "[column N]" blocks.
 */
function htmlToDigest(html: string, rightTabs: boolean) {
  const lines: string[] = [];
  let layoutTable = false;
  const blocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>|<(h[1-6]|p|li)[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  for (const block of blocks) {
    if (!block.startsWith("<tr")) {
      const line = annotate(block, rightTabs);
      if (line) lines.push(line);
      continue;
    }
    const cells = (block.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((cell) =>
      (cell.match(BLOCK) ?? [])
        .map((inner) => annotate(inner, rightTabs))
        .filter((line): line is string => line !== null),
    );
    if (cells.length >= 2 && cells.filter((cell) => cell.length >= 3).length >= 2) {
      layoutTable = true;
      cells.forEach((cell, index) => lines.push(`[column ${index + 1}]`, ...cell));
    } else {
      const text = cells.map((cell) => cell.join(" / ")).filter(Boolean);
      if (text.length) lines.push(`[table-row] ${text.join(" | ")}`);
    }
  }
  return { lines, layoutTable };
}

const TWIPS_PER_INCH = 1440;

async function docxXmlHints(data: Uint8Array) {
  const zip = await JSZip.loadAsync(data);
  const documentXml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const stylesXml = (await zip.file("word/styles.xml")?.async("string")) ?? "";

  const pgSz = /<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/.exec(documentXml);
  const pgMar = /<w:pgMar[^>]*w:left="(\d+)"/.exec(documentXml);
  const fonts = new Set<string>();
  for (const match of (documentXml + stylesXml).matchAll(/w:rFonts[^>]*w:ascii="([^"]+)"/g)) {
    fonts.add(match[1]!);
  }
  const sizes = [...(documentXml + stylesXml).matchAll(/<w:sz w:val="(\d+)"/g)].map(
    (match) => Number(match[1]) / 2,
  );
  // Body size: document defaults, else the Normal style. Never guessed from
  // the most common size (heading styles would dominate in short templates).
  const docDefaults = /<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/.exec(stylesXml)?.[1] ?? "";
  const defaultSize =
    /<w:sz w:val="(\d+)"/.exec(docDefaults)?.[1] ??
    /<w:style [^>]*w:styleId="Normal"[^>]*>(?:(?!<\/w:style>)[\s\S])*?<w:sz w:val="(\d+)"/.exec(
      stylesXml,
    )?.[1];

  return {
    pageSize: pgSz
      ? pageSizeFrom(
          (Number(pgSz[1]) / TWIPS_PER_INCH) * 72,
          (Number(pgSz[2]) / TWIPS_PER_INCH) * 72,
        )
      : "unknown",
    marginsInches: pgMar ? Math.round((Number(pgMar[1]) / TWIPS_PER_INCH) * 10) / 10 : undefined,
    fonts: [...fonts].slice(0, 10),
    baseSizePt: defaultSize ? Number(defaultSize) / 2 : undefined,
    sizes,
    hasColumns: /<w:cols[^>]*w:num="[2-9]"/.test(documentXml),
    hasTables: documentXml.includes("<w:tbl>"),
    hasRightTabs: /<w:tab w:val="right"/.test(documentXml),
  } as const;
}

export async function docxTemplateLayout(data: Uint8Array): Promise<TemplateLayout> {
  await assertSafeDocxPackage(data); // before anything decompresses the upload
  const buffer = Buffer.from(data);
  const xml = await docxXmlHints(data);
  const [{ value: html }, { value: text }] = await Promise.all([
    mammoth.convertToHtml({ buffer }, { styleMap: ["u => u"] }),
    mammoth.extractRawText({ buffer }),
  ]);
  const { lines, layoutTable } = htmlToDigest(html, xml.hasRightTabs);
  const baseSizePt = xml.baseSizePt;
  return {
    text,
    digest: lines.join("\n").slice(0, MAX_DIGEST_CHARS),
    hints: {
      pageSize: xml.pageSize,
      marginsInches: xml.marginsInches,
      fonts: xml.fonts,
      baseSizePt,
      headingSizesPt: [...new Set(xml.sizes.filter((s) => baseSizePt && s > baseSizePt))].sort(
        (a, b) => b - a,
      ),
      twoColumnsLikely: xml.hasColumns || layoutTable,
      rightAlignedText: xml.hasRightTabs,
      hasTables: xml.hasTables,
    },
  };
}

export async function extractTemplateLayout(
  data: Uint8Array,
  mimeType: string,
): Promise<TemplateLayout> {
  if (mimeType === "application/pdf") return pdfTemplateLayout(data);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return docxTemplateLayout(data);
  }
  throw new Error("Unsupported template type");
}
