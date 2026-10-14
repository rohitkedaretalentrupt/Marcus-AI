import { Document, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Builds real PDF/DOCX files in memory for tests (no binary fixtures in git). */

export async function makePdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([612, 792]);
  let y = 750;
  for (const line of lines) {
    if (y < 50) {
      page = pdf.addPage([612, 792]);
      y = 750;
    }
    if (line) page.drawText(line, { x: 50, y, size: 11, font });
    y -= 16;
  }
  return pdf.save();
}

/** A PDF with no text layer at all (like a scanned image). */
export async function makeEmptyPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

export async function makeDocx(lines: string[]): Promise<Uint8Array> {
  const document = new Document({
    sections: [{ children: lines.map((text) => new Paragraph({ text })) }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** Fictional, test-only resume. */
export const SAMPLE_RESUME_LINES = [
  "Sam Rivera",
  "Data Analyst",
  "sam.rivera@example.test | 555-010-4477 | Denver, CO",
  "",
  "Summary",
  "Analyst with 5 years of experience in healthcare reporting.",
  "",
  "Experience",
  "Senior Data Analyst",
  "Contoso Health",
  "Feb 2021 - Present",
  "• Built 30 operational dashboards",
  "• Automated monthly reporting",
  "",
  "Education",
  "University of Colorado",
  "B.S. Statistics, 2018",
  "",
  "Skills",
  "SQL, Python, Tableau",
];

/** A one-page template-like PDF: large uppercase headings, a right-aligned date, placeholders. */
export async function makeTemplatePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]); // A4
  const draw = (text: string, x: number, y: number, size: number, font = regular) =>
    page.drawText(text, { x, y, size, font });
  draw("[CANDIDATE NAME]", 56, 790, 20, bold);
  draw("[Job Title] | [Email] | [Phone]", 56, 768, 10);
  draw("PROFESSIONAL SUMMARY", 56, 735, 13, bold);
  draw("[3-4 lines summarising the candidate's experience]", 56, 718, 10);
  draw("EXPERIENCE", 56, 690, 13, bold);
  draw("[Role], [Company]", 56, 672, 10, bold);
  draw("[MM/YYYY] - [MM/YYYY]", 430, 672, 10);
  draw("- [Achievement bullet]", 66, 656, 10);
  draw("EDUCATION", 56, 625, 13, bold);
  draw("[Degree], [Institution]", 56, 607, 10);
  return pdf.save();
}

/** A template-like DOCX with real heading styles, a bullet list and a table. */
export async function makeTemplateDocx(): Promise<Uint8Array> {
  const { HeadingLevel, Table, TableRow, TableCell, TextRun } = await import("docx");
  const document = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        children: [
          new Paragraph({ text: "[Candidate Name]", heading: HeadingLevel.TITLE }),
          new Paragraph({ text: "Key Skills", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "[Skill 1]", bullet: { level: 0 } }),
          new Paragraph({ text: "Employment History", heading: HeadingLevel.HEADING_1 }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("[Company]")] }),
                  new TableCell({ children: [new Paragraph("[Dates]")] }),
                ],
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun({ text: "Education", bold: true })] }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** A two-column PDF template: a left sidebar and a main column on shared baselines. */
export async function makeTwoColumnPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  const draw = (text: string, x: number, y: number, size: number, font = regular) =>
    page.drawText(text, { x, y, size, font });
  draw("[CANDIDATE NAME]", 40, 790, 22, bold);
  const sidebar = [
    "CONTACT",
    "[Email]",
    "[Phone]",
    "",
    "SKILLS",
    "[Skill 1]",
    "[Skill 2]",
    "[Skill 3]",
    "",
    "LANGUAGES",
    "[Language]",
  ];
  const main = [
    "PROFILE",
    "[Short profile paragraph]",
    "",
    "EXPERIENCE",
    "[Role] at [Company]",
    "[Achievement bullet]",
    "[Achievement bullet]",
    "",
    "EDUCATION",
    "[Degree], [Institution]",
    "",
  ];
  sidebar.forEach((text, i) => {
    if (text)
      draw(
        text,
        40,
        740 - i * 18,
        /^[A-Z]+$/.test(text) ? 12 : 10,
        /^[A-Z]+$/.test(text) ? bold : regular,
      );
  });
  main.forEach((text, i) => {
    if (text)
      draw(
        text,
        220,
        740 - i * 18,
        /^[A-Z]+$/.test(text) ? 12 : 10,
        /^[A-Z]+$/.test(text) ? bold : regular,
      );
  });
  return pdf.save();
}

/** A DOCX template using real section columns (w:cols num=2). */
export async function makeTwoColumnDocx(): Promise<Uint8Array> {
  const { HeadingLevel } = await import("docx");
  const document = new Document({
    sections: [
      {
        properties: { column: { count: 2, space: 400 } },
        children: [
          new Paragraph({ text: "Skills", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "[Skill]", bullet: { level: 0 } }),
          new Paragraph({ text: "Experience", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "[Role], [Company]" }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** A DOCX template laid out as a borderless 2-cell table (a very common "two-column" CV). */
export async function makeTableLayoutDocx(): Promise<Uint8Array> {
  const { Table, TableRow, TableCell, WidthType } = await import("docx");
  const cell = (lines: string[], width: number) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      children: lines.map((text) => new Paragraph(text)),
    });
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "[Candidate Name]" }),
          new Table({
            columnWidths: [3000, 6000],
            rows: [
              new TableRow({
                children: [
                  cell(["CONTACT", "[Email]", "SKILLS", "[Skill]"], 3000),
                  cell(["EXPERIENCE", "[Role] [Dates]", "EDUCATION", "[Degree]"], 6000),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** Different heading styles: Heading 1/2, bold caps, underlined; right-aligned dates via a right tab stop. */
export async function makeHeadingStylesDocx(): Promise<Uint8Array> {
  const { HeadingLevel, TextRun, TabStopType } = await import("docx");
  const dated = (role: string, dates: string) =>
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9000 }],
      children: [new TextRun({ text: role, bold: true }), new TextRun({ text: `\t${dates}` })],
    });
  const document = new Document({
    styles: { default: { document: { run: { font: "Garamond", size: 21 } } } },
    sections: [
      {
        children: [
          new Paragraph({ text: "[Name]", heading: HeadingLevel.TITLE }),
          new Paragraph({ text: "Professional Profile", heading: HeadingLevel.HEADING_1 }),
          new Paragraph("[Profile text]"),
          new Paragraph({
            children: [new TextRun({ text: "CAREER HISTORY", bold: true, allCaps: true })],
          }),
          dated("[Job Title], [Company]", "[MMM YYYY] – [MMM YYYY]"),
          new Paragraph({ text: "Education", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun({ text: "Certifications", underline: {} })] }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
