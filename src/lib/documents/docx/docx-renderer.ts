import "server-only";

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  Tab,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type IBorderOptions,
  type ParagraphChild,
} from "docx";
import JSZip from "jszip";

import { resolveEntryRef } from "@/lib/formatting/content-refs";
import type { FormattingPlan, PlanSection } from "@/lib/formatting/plan";

import type { ResumeContent, ResumeEntry } from "../resume-content";
import {
  DOCUMENT_MIME_TYPES,
  type DocumentRenderer,
  type RenderDocumentRequest,
  type RenderedDocument,
} from "../types";
import {
  cleanText,
  isSafeWebUrl,
  linkDisplayText,
  stripInvalidChars,
  toParagraphs,
  toSentences,
} from "./text";

/*
 * Deterministic DOCX renderer: ResumeContent (facts) + a finalized
 * FormattingPlan (presentation) → .docx via the `docx` library. The same
 * input always produces the same document body. The renderer owns the
 * document structure; nothing from the AI or the resume is ever interpreted
 * as markup (all text goes through text runs, which are XML-escaped).
 *
 * Layout safety: sizes, margins and spacing are clamped to readable ranges;
 * content is never dropped or shrunk to fit a page — long resumes simply use
 * more pages.
 */

const TWIPS_PER_INCH = 1440;
const PAGE_TWIPS = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
} as const;
const BULLET_REF = "resume-bullets";
const DEFAULT_FONT = "Calibri";
const COLUMN_GAP_TWIPS = 360;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const pt = (points: number) => Math.round(points * 20); // twips
const halfPt = (points: number) => Math.round(points * 2); // run size unit

/** Relative luminance (0 = black, 1 = white). */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** Colours must stay readable on white paper. */
const readable = (hex: string | undefined, fallback: string, max = 0.35) =>
  hex && luminance(hex) <= max ? hex : fallback;

interface Style {
  bodyFont: string;
  headingFont: string;
  bodySize: number;
  headingSize: number;
  nameSize: number;
  textColor: string;
  headingColor: string;
  linkColor: string;
  dividerColor: string;
  lineSpacing: number;
  paragraphAfter: number;
  sectionBefore: number;
  entryGap: number;
  bulletIndent: number;
}

/** Clamps the plan's presentation values into readable, stable ranges. */
function resolveStyle(plan: FormattingPlan): Style {
  const t = plan.typography;
  const bodySize = clamp(t.bodySizePt ?? 10.5, 9, 12);
  const headingSize = clamp(t.headingSizePt ?? bodySize + 1.5, bodySize, 18);
  const textColor = readable(t.textColor, "1A1A1A");
  return {
    bodyFont: t.bodyFont ?? DEFAULT_FONT,
    headingFont: t.headingFont ?? t.bodyFont ?? DEFAULT_FONT,
    bodySize,
    headingSize,
    nameSize: clamp(t.nameSizePt ?? headingSize + 6, Math.max(14, headingSize), 28),
    textColor,
    headingColor: readable(t.headingColor, textColor),
    linkColor: readable(t.linkColor, "1F4E79", 0.4),
    dividerColor: readable(plan.dividers.color, "8C8C8C", 0.6),
    lineSpacing: clamp(plan.spacing.lineSpacing, 1, 1.5),
    paragraphAfter: clamp(plan.spacing.paragraphAfterPt, 0, 8),
    sectionBefore: clamp(plan.spacing.sectionBeforePt, 4, 18),
    entryGap: clamp(plan.spacing.entryGapPt, 0, 12),
    bulletIndent: clamp(plan.bullets.indentInches, 0.15, 0.6),
  };
}

function applyCase(text: string, mode: FormattingPlan["typography"]["headingCase"]): string {
  if (mode === "upper") return text.toLocaleUpperCase();
  if (mode === "title") {
    return text
      .toLowerCase()
      .replace(/(^|[\s(/-])(\p{L})/gu, (_m, p, c: string) => p + c.toUpperCase());
  }
  return text;
}

/** Renders one document; `width` is the usable width (twips) of the current column. */
/** A heading that is really an analysis note: fully in parentheses, or saying there is no heading. */
export function isUnheaded(heading: string): boolean {
  const text = heading.trim();
  return (
    /^\(.*\)$/.test(text) ||
    /\bno (?:explicit |visible )?heading\b|\bunheaded\b|\bwithout (?:a )?heading\b/i.test(text)
  );
}

class DocxBuilder {
  private readonly style: Style;

  constructor(
    private readonly content: ResumeContent,
    private readonly plan: FormattingPlan,
  ) {
    this.style = resolveStyle(plan);
  }

  // --- runs ---------------------------------------------------------------

  private run(text: string, options: { bold?: boolean; italics?: boolean; size?: number } = {}) {
    return new TextRun({
      text: stripInvalidChars(text), // separators keep their spaces; content is pre-trimmed
      bold: options.bold,
      italics: options.italics,
      size: options.size ? halfPt(options.size) : undefined,
    });
  }

  /** A real tab element (aligned by the paragraph's right tab stop). */
  private tab() {
    return new TextRun({ children: [new Tab()] });
  }

  private link(url: string, text: string): ParagraphChild {
    return new ExternalHyperlink({
      link: url,
      children: [
        new TextRun({ text: cleanText(text), color: this.style.linkColor, underline: {} }),
      ],
    });
  }

  private paragraph(
    children: ParagraphChild[],
    options: {
      before?: number;
      after?: number;
      alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
      keepNext?: boolean;
      tabAt?: number;
      bullet?: 0 | 1;
      border?: IBorderOptions;
      pageBreakBefore?: boolean;
    } = {},
  ) {
    return new Paragraph({
      children,
      alignment: options.alignment,
      keepNext: options.keepNext,
      keepLines: true,
      pageBreakBefore: options.pageBreakBefore || undefined,
      spacing: {
        before: pt(options.before ?? 0),
        after: pt(options.after ?? this.style.paragraphAfter),
        line: Math.round(240 * this.style.lineSpacing),
      },
      tabStops:
        options.tabAt !== undefined
          ? [{ type: TabStopType.RIGHT, position: options.tabAt }]
          : undefined,
      numbering:
        options.bullet !== undefined ? { reference: BULLET_REF, level: options.bullet } : undefined,
      border: options.border ? { bottom: options.border } : undefined,
    });
  }

  // --- header ---------------------------------------------------------------

  private header(): Paragraph[] {
    const { contact } = this.content;
    const { header } = this.plan;
    const alignment = {
      left: AlignmentType.LEFT,
      center: AlignmentType.CENTER,
      right: AlignmentType.RIGHT,
    }[header.alignment];

    const out: Paragraph[] = [
      this.paragraph(
        [
          new TextRun({
            text: cleanText(contact.fullName),
            bold: true,
            size: halfPt(this.style.nameSize),
            font: this.style.headingFont,
            color: this.style.headingColor,
          }),
        ],
        { alignment, after: 2 },
      ),
    ];
    if (contact.headline && header.fields.includes("headline")) {
      out.push(this.paragraph([this.run(contact.headline, { italics: true })], { alignment }));
    }

    const parts: ParagraphChild[][] = [];
    for (const field of header.fields) {
      if (field === "email" && contact.email) {
        parts.push([this.link(`mailto:${contact.email}`, contact.email)]);
      } else if (field === "phone" && contact.phone) {
        parts.push([this.run(contact.phone)]);
      } else if (field === "location" && contact.location) {
        parts.push([this.run(contact.location)]);
      } else if (field === "links") {
        for (const link of contact.links) {
          parts.push([
            isSafeWebUrl(link.url)
              ? this.link(link.url, linkDisplayText(link.url))
              : this.run(linkDisplayText(link.url)),
          ]);
        }
      }
    }
    if (parts.length === 0) return out;

    if (header.contactLayout === "stacked") {
      parts.forEach((part) => out.push(this.paragraph(part, { alignment, after: 0 })));
    } else {
      const separator = header.separator === "," ? ", " : `  ${header.separator}  `;
      const children = parts.flatMap((part, i) =>
        i === 0 ? part : [this.run(separator), ...part],
      );
      out.push(this.paragraph(children, { alignment }));
    }
    return out;
  }

  // --- sections ---------------------------------------------------------------

  private heading(section: PlanSection, first: boolean): Paragraph {
    const { typography, dividers } = this.plan;
    return this.paragraph(
      [
        new TextRun({
          text: cleanText(applyCase(section.heading, typography.headingCase)),
          bold: typography.headingBold,
          underline: typography.headingUnderline ? {} : undefined,
          size: halfPt(this.style.headingSize),
          font: this.style.headingFont,
          color: this.style.headingColor,
        }),
      ],
      {
        before: first ? 0 : this.style.sectionBefore,
        after: 3,
        keepNext: true,
        pageBreakBefore: section.pageBreakBefore,
        border: dividers.underHeadings
          ? { style: BorderStyle.SINGLE, size: 6, color: this.style.dividerColor, space: 1 }
          : undefined,
      },
    );
  }

  private dates(entry: ResumeEntry): string {
    const sep =
      this.plan.entries.dateSeparator === "to" ? " to " : ` ${this.plan.entries.dateSeparator} `;
    return [entry.startDate, entry.endDate]
      .filter(Boolean)
      .map((d) => cleanText(d!))
      .join(sep);
  }

  private titles(entry: ResumeEntry): [string | undefined, string | undefined] {
    const clean = (text: string | undefined) => (text ? cleanText(text) || undefined : undefined);
    return this.plan.entries.titleOrder === "subheading_first" && entry.subheading
      ? [clean(entry.subheading), clean(entry.heading)]
      : [clean(entry.heading), clean(entry.subheading)];
  }

  /** The section being rendered (its `textAsBullets` applies to every entry body). */
  private section: PlanSection | null = null;

  /**
   * Description text: one bullet per sentence when the section shows its
   * details as bullet points (wording unchanged), else plain paragraphs.
   */
  private description(entry: ResumeEntry, bulletLevel: 0 | 1): Paragraph[] {
    return this.section?.textAsBullets
      ? toSentences(entry.description).map((text) =>
          this.paragraph([this.run(text)], { bullet: bulletLevel }),
        )
      : toParagraphs(entry.description).map((text) => this.paragraph([this.run(text)]));
  }

  /** Description paragraphs + bullets shared by several layouts. */
  private body(entry: ResumeEntry, bulletLevel: 0 | 1 = 0): Paragraph[] {
    return [
      ...this.description(entry, bulletLevel),
      ...entry.bullets
        .map(cleanText)
        .filter(Boolean)
        .map((text) => this.paragraph([this.run(text)], { bullet: bulletLevel })),
    ];
  }

  private entryBlock(entry: ResumeEntry, width: number, before: number): Paragraph[] {
    const { datePosition, subheadingItalic } = this.plan.entries;
    const [primary, secondary] = this.titles(entry);
    const dates = this.dates(entry);
    const out: Paragraph[] = [];

    const line1: ParagraphChild[] = [];
    if (primary) line1.push(this.run(primary, { bold: true }));
    if (dates && datePosition === "right") line1.push(this.tab(), this.run(dates));
    if (dates && datePosition === "inline") line1.push(this.run(primary ? `  |  ${dates}` : dates));
    const hasBody = Boolean(entry.description) || entry.bullets.length > 0;
    if (line1.length > 0) {
      out.push(
        this.paragraph(line1, {
          before,
          keepNext: hasBody || Boolean(secondary),
          tabAt: datePosition === "right" ? width : undefined,
        }),
      );
    }

    const line2: ParagraphChild[] = [];
    if (secondary) line2.push(this.run(secondary, { italics: subheadingItalic }));
    if (entry.location) {
      if (datePosition === "right" && secondary) line2.push(this.tab());
      else if (secondary) line2.push(this.run(", "));
      line2.push(this.run(cleanText(entry.location)));
    }
    if (line2.length > 0) {
      out.push(
        this.paragraph(line2, {
          before: out.length === 0 ? before : 0,
          keepNext: hasBody,
          tabAt: datePosition === "right" ? width : undefined,
        }),
      );
    }
    if (dates && datePosition === "below") {
      out.push(this.paragraph([this.run(dates, { italics: true })], { keepNext: hasBody }));
    }
    out.push(...this.body(entry));
    return out;
  }

  private bulletBlock(entry: ResumeEntry): Paragraph[] {
    const [primary, secondary] = this.titles(entry);
    const dates = this.dates(entry);
    const label = [primary, secondary, entry.location].filter(Boolean).map((t) => cleanText(t!));
    if (label.length === 0 && !dates) {
      const texts = this.section?.textAsBullets
        ? toSentences(entry.description)
        : toParagraphs(entry.description);
      return [
        ...texts.map((text) => this.paragraph([this.run(text)], { bullet: 0 })),
        ...entry.bullets
          .map(cleanText)
          .filter(Boolean)
          .map((text) => this.paragraph([this.run(text)], { bullet: 0 })),
      ];
    }
    const head: ParagraphChild[] = [];
    if (label[0]) head.push(this.run(label[0], { bold: true }));
    if (label.length > 1) head.push(this.run(`, ${label.slice(1).join(", ")}`));
    if (dates) head.push(this.run(head.length ? ` (${dates})` : dates));
    return [this.paragraph(head, { bullet: 0 }), ...this.body(entry, 1)];
  }

  private inlineBlock(entry: ResumeEntry): Paragraph[] {
    const items = [
      entry.subheading,
      entry.location,
      ...toParagraphs(entry.description),
      ...entry.bullets,
    ]
      .filter((item): item is string => Boolean(item && cleanText(item)))
      .map(cleanText);
    const separator = items.every((item) => item.length <= 40 && !item.includes(","))
      ? ", "
      : "  •  ";
    const children: ParagraphChild[] = [];
    if (entry.heading) children.push(this.run(`${entry.heading}: `, { bold: true }));
    items.forEach((item, i) => children.push(this.run(i === 0 ? item : `${separator}${item}`)));
    const dates = this.dates(entry);
    if (dates) children.push(this.run(children.length ? ` (${dates})` : dates));
    return children.length ? [this.paragraph(children)] : [];
  }

  private paragraphBlock(entry: ResumeEntry, width: number, before: number): Paragraph[] {
    const hasTitle = entry.heading || entry.subheading || entry.startDate || entry.endDate;
    const head = hasTitle
      ? this.entryBlock({ ...entry, description: undefined, bullets: [] }, width, before)
      : [];
    const texts = [
      ...toParagraphs(entry.description),
      ...entry.bullets.map(cleanText).filter(Boolean),
    ];
    return [...head, ...texts.map((text) => this.paragraph([this.run(text)]))];
  }

  private tableBlock(entries: ResumeEntry[], width: number): Table {
    const dateWidth = Math.round(width * 0.24);
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const borders = {
      top: none,
      bottom: none,
      left: none,
      right: none,
      insideHorizontal: none,
      insideVertical: none,
    };
    return new Table({
      layout: TableLayoutType.FIXED,
      width: { size: width, type: WidthType.DXA },
      columnWidths: [dateWidth, width - dateWidth],
      borders,
      rows: entries.map(
        (entry, index) =>
          new TableRow({
            cantSplit: false,
            children: [
              new TableCell({
                width: { size: dateWidth, type: WidthType.DXA },
                borders,
                margins: { right: 120 },
                verticalAlign: VerticalAlign.TOP,
                children: [
                  this.paragraph(this.dates(entry) ? [this.run(this.dates(entry))] : [], {
                    before: index === 0 ? 0 : this.style.entryGap,
                  }),
                ],
              }),
              new TableCell({
                width: { size: width - dateWidth, type: WidthType.DXA },
                borders,
                verticalAlign: VerticalAlign.TOP,
                children: this.withoutDates(
                  entry,
                  width - dateWidth - 120,
                  index === 0 ? 0 : this.style.entryGap,
                ),
              }),
            ],
          }),
      ),
    });
  }

  private withoutDates(entry: ResumeEntry, width: number, before: number): Paragraph[] {
    const block = this.entryBlock(
      { ...entry, startDate: undefined, endDate: undefined },
      width,
      before,
    );
    return block.length ? block : [this.paragraph([])];
  }

  /** Bold label naming where a group of items comes from ("Languages"), in grouped bullet sections. */
  private groupLabel(title: string): Paragraph {
    return this.paragraph([this.run(title, { bold: true })], { before: 4, keepNext: true });
  }

  private sectionBlock(section: PlanSection, width: number, first: boolean): (Paragraph | Table)[] {
    this.section = section;
    // A template section without a heading (the analysis describes it, e.g.
    // "(No explicit heading; employer entries)") gets no heading line.
    const out: (Paragraph | Table)[] = isUnheaded(section.heading)
      ? []
      : [this.heading(section, first)];
    const grouped = section.groupBySource && section.layout === "bullets";
    let group: string | null = null;
    const entries: ResumeEntry[] = [];
    const flushTable = () => {
      if (entries.length) out.push(this.tableBlock(entries.splice(0), width));
    };

    let index = 0;
    for (const ref of section.sources) {
      if (ref === "summary") {
        flushTable();
        if (grouped && group !== "summary") {
          group = "summary";
          out.push(this.groupLabel("Summary"));
        }
        if (section.textAsBullets) {
          for (const text of toSentences(this.content.summary))
            out.push(this.paragraph([this.run(text)], { bullet: 0 }));
        } else {
          for (const text of toParagraphs(this.content.summary))
            out.push(this.paragraph([this.run(text)]));
        }
        continue;
      }
      const resolved = resolveEntryRef(this.content, ref);
      if (!resolved) continue; // finalized plans contain only valid refs
      if (grouped && group !== `s${resolved.sectionIndex}`) {
        group = `s${resolved.sectionIndex}`;
        out.push(this.groupLabel(this.content.sections[resolved.sectionIndex]!.title));
      }
      const entry = resolved.entry;
      const before = index++ === 0 ? 0 : this.style.entryGap;
      switch (section.layout) {
        case "table":
          entries.push(entry);
          break;
        case "bullets":
          out.push(...this.bulletBlock(entry));
          break;
        case "inline":
          out.push(...this.inlineBlock(entry));
          break;
        case "paragraph":
          out.push(...this.paragraphBlock(entry, width, before));
          break;
        default:
          out.push(...this.entryBlock(entry, width, before));
      }
    }
    flushTable();
    return out;
  }

  /** `nested`: inside the two-column table, where table layouts become entries (no nested tables). */
  private column(sections: PlanSection[], width: number, nested = false): (Paragraph | Table)[] {
    return sections.flatMap((section, i) =>
      this.sectionBlock(
        nested && section.layout === "table" ? { ...section, layout: "entries" } : section,
        width,
        i === 0,
      ),
    );
  }

  // --- document ---------------------------------------------------------------

  build(): Document {
    const { page } = this.plan;
    const size = PAGE_TWIPS[page.size];
    const m = page.marginsInches ?? { top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 };
    const margin = (inches: number) => Math.round(clamp(inches, 0.4, 1.5) * TWIPS_PER_INCH);
    const margins = {
      top: margin(m.top),
      right: margin(m.right),
      bottom: margin(m.bottom),
      left: margin(m.left),
    };
    const width = size.width - margins.left - margins.right;

    const side = this.plan.sections.filter((section) => section.column === "side");
    const main = this.plan.sections.filter((section) => section.column !== "side");
    let body: (Paragraph | Table)[];
    if (page.columns === 2 && side.length > 0 && main.length > 0) {
      const sideWidth = Math.round((width * clamp(page.sideColumnWidthPercent, 22, 40)) / 100);
      const mainWidth = width - sideWidth;
      const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
      const borders = {
        top: none,
        bottom: none,
        left: none,
        right: none,
        insideHorizontal: none,
        insideVertical: none,
      };
      const cell = (sections: PlanSection[], cellWidth: number, gap: "left" | "right") =>
        new TableCell({
          width: { size: cellWidth, type: WidthType.DXA },
          borders,
          margins: gap === "right" ? { right: COLUMN_GAP_TWIPS } : { left: COLUMN_GAP_TWIPS },
          verticalAlign: VerticalAlign.TOP,
          children: this.column(sections, cellWidth - COLUMN_GAP_TWIPS, true) as Paragraph[],
        });
      const sideFirst = page.sideColumn === "left";
      const cells = sideFirst
        ? [cell(side, sideWidth, "right"), cell(main, mainWidth, "left")]
        : [cell(main, mainWidth, "right"), cell(side, sideWidth, "left")];
      body = [
        new Table({
          layout: TableLayoutType.FIXED,
          width: { size: width, type: WidthType.DXA },
          columnWidths: sideFirst ? [sideWidth, mainWidth] : [mainWidth, sideWidth],
          borders,
          rows: [new TableRow({ children: cells })],
        }),
      ];
    } else {
      body = this.column(this.plan.sections, width);
    }

    const { bullets } = this.plan;
    const indent = Math.round(this.style.bulletIndent * TWIPS_PER_INCH);
    return new Document({
      creator: "Marcus AI",
      lastModifiedBy: "Marcus AI",
      title: `${cleanText(this.content.contact.fullName)} - Resume`,
      revision: 1,
      styles: {
        default: {
          document: {
            run: {
              font: this.style.bodyFont,
              size: halfPt(this.style.bodySize),
              color: this.style.textColor,
            },
          },
        },
      },
      numbering: {
        config: [
          {
            reference: BULLET_REF,
            levels: [
              {
                level: 0,
                format: LevelFormat.BULLET,
                text: bullets.symbol,
                alignment: AlignmentType.LEFT,
                style: { paragraph: { indent: { left: indent + 220, hanging: 220 } } },
              },
              {
                level: 1,
                format: LevelFormat.BULLET,
                text: "–",
                alignment: AlignmentType.LEFT,
                style: { paragraph: { indent: { left: indent * 2 + 440, hanging: 220 } } },
              },
            ],
          },
        ],
      },
      sections: [
        {
          properties: {
            page: { size: { width: size.width, height: size.height }, margin: margins },
          },
          footers: this.plan.footer.pageNumbers
            ? {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({ children: [PageNumber.CURRENT], size: halfPt(8.5) }),
                      ],
                    }),
                  ],
                }),
              }
            : undefined,
          children: [...this.header(), ...body],
        },
      ],
    });
  }
}

/**
 * The docx library gives hyperlink relationships random ids; replace them
 * with sequential ones so identical input yields an identical document body.
 */
async function normaliseRelationshipIds(data: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const documentFile = zip.file("word/document.xml");
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (!documentFile || !relsFile) return data;
  let documentXml = await documentFile.async("string");
  let relsXml = await relsFile.async("string");

  const ids = [...new Set(documentXml.match(/r:id="(rId[^"]*[^\d"][^"]*)"/g) ?? [])].map((attr) =>
    attr.slice(6, -1),
  );
  if (ids.length === 0) return data;
  ids.forEach((id, index) => {
    const stable = `rIdLink${index + 1}`;
    documentXml = documentXml.replaceAll(`r:id="${id}"`, `r:id="${stable}"`);
    relsXml = relsXml.replaceAll(`Id="${id}"`, `Id="${stable}"`);
  });
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", relsXml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function createDocxRenderer(): DocumentRenderer {
  return {
    format: "docx",
    async render({ content, plan }: RenderDocumentRequest): Promise<RenderedDocument> {
      const document = new DocxBuilder(content, plan).build();
      const packed = new Uint8Array(await Packer.toBuffer(document));
      const data = await normaliseRelationshipIds(packed);
      return { format: "docx", mimeType: DOCUMENT_MIME_TYPES.docx, data };
    },
  };
}
