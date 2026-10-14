import {
  AlignmentType,
  Document,
  LevelFormat,
  Packer,
  Paragraph,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
} from "docx";

/**
 * TEST-ONLY synthetic client template in the style of a staffing submission
 * form: a candidate-information table, a summary cell, a skills table with
 * sample rows, then experience as paragraphs (bold "Employer<TAB>dates"
 * line, a title line, bullets) with two sample jobs. Every value is a
 * fictional sample person that must never survive filling.
 */
export const FORM_SAMPLE = {
  name: "Pat Example-Sample",
  location: "Sampletown, ZZ 00000",
  start: "Yes",
  summary: "Pat Example-Sample is a seasoned sample operator with many years of sample experience.",
  skill1: "Sample Press Operation",
  skill2: "Sample Extrusion",
  years: "3+ year",
  employer1: "Sample Industries",
  title1: "Sample Operator",
  bullet1: "Operated sample machinery to keep the sample line moving",
  bullet2: "Assisted with sample packaging and sample line support",
  employer2: "Second Sample Works",
  title2: "Second Sample Role",
  bullet3: "Monitored second sample performance on every sample shift",
} as const;

const cell = (text: string, bold = false) =>
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });

export async function makeFormTemplateDocx(): Promise<Uint8Array> {
  const s = FORM_SAMPLE;
  const employerLine = (employer: string, dates: string) =>
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9000 }],
      children: [
        new TextRun({ text: employer, bold: true }),
        new TextRun({ children: [new Tab(), dates], bold: true }),
      ],
    });
  const bullet = (text: string) =>
    new Paragraph({ numbering: { reference: "dots", level: 0 }, text });
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "dots",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT },
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          new Table({
            rows: [
              new TableRow({ children: [cell("CANDIDATE INFORMATION", true)] }),
              new TableRow({ children: [cell("Name:", true), cell(s.name)] }),
              new TableRow({ children: [cell("Current Location:", true), cell(s.location)] }),
              new TableRow({
                children: [cell("Can start within 2 weeks (yes/no)?", true), cell(s.start)],
              }),
            ],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [cell("SUMMARY (Use this section for a candidate summary)")],
              }),
              new TableRow({ children: [cell(s.summary)] }),
            ],
          }),
          new Table({
            rows: [
              new TableRow({ children: [cell("SKILLS", true)] }),
              new TableRow({
                children: [cell("Skill/Competency", true), cell("Years of Experience", true)],
              }),
              new TableRow({ children: [cell(s.skill1), cell(s.years)] }),
              new TableRow({ children: [cell(s.skill2), cell(s.years)] }),
            ],
          }),
          new Paragraph(""),
          employerLine(s.employer1, "Feb 2020 – May 2023"),
          new Paragraph({ children: [new TextRun({ text: s.title1, bold: true })] }),
          bullet(s.bullet1),
          bullet(s.bullet2),
          new Paragraph(""),
          employerLine(s.employer2, "Apr 2017 – Jan 2020"),
          new Paragraph({ children: [new TextRun({ text: s.title2, bold: true })] }),
          bullet(s.bullet3),
          new Paragraph(""),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
