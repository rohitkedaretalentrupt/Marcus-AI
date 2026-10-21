import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ResumeContent } from "@/lib/documents/resume-content";
import { aiFillPlanSchema, type AIFillPlan } from "@/lib/formatting/fill-plan";
import {
  contentShownByFillPlan,
  finalizeFillPlan,
  sampleValues,
} from "@/lib/formatting/finalize-fill-plan";
import { FORM_SAMPLE, makeFormTemplateDocx } from "@test/fixtures/form-template";

import { documentXmlText, expectedTexts, validateDocx } from "./docx-validation";
import { isLabelLike, type BlockInfo } from "./template-blocks";
import { fillDocxTemplate, readTemplateBlocks } from "./template-fill";
import { comparable } from "./text";

/** Fictional, synthetic resume (test-only). */
const RESUME: ResumeContent = {
  contact: {
    fullName: "Riley Synthetic",
    headline: "Forklift Operator",
    email: "riley.synthetic@example.test",
    phone: "555-010-9090",
    location: "Avon, IN",
    links: [],
  },
  summary: "Forklift operator with safe material handling experience. Trains new operators.",
  sections: [
    {
      kind: "experience",
      title: "Employment history",
      entries: [
        {
          heading: "Forklift Operator",
          subheading: "Example Bakeries",
          startDate: "Mar 2021",
          endDate: "Present",
          description: "Inspected forklifts daily. Logged load weights each shift.",
          bullets: [],
        },
        {
          heading: "Warehouse Associate",
          subheading: "Example Logistics",
          startDate: "Jan 2018",
          endDate: "Feb 2021",
          bullets: ["Picked and packed orders"],
        },
      ],
    },
    {
      kind: "skills",
      title: "Skills",
      entries: [{ bullets: ["Reach truck", "Pallet jack", "Cycle count"] }],
    },
    {
      kind: "education",
      title: "Education",
      entries: [
        {
          heading: "High school diploma",
          subheading: "Example High School",
          endDate: "2015",
          bullets: [],
        },
      ],
    },
    {
      kind: "custom",
      title: "Languages",
      entries: [{ heading: "English, Spanish", bullets: [] }],
    },
  ],
};

const source = { resumeFileId: "f", templateId: "t", templateAnalyzedAt: null, engineVersion: 3 };

/** Block ids by their text, so the tests do not depend on numbering. */
function ids(blocks: BlockInfo[]) {
  const paragraph = (text: string) =>
    blocks.find((b) => b.kind === "paragraph" && b.text.startsWith(text))!.id;
  const cell = (text: string) => {
    for (const block of blocks) {
      if (block.kind !== "table") continue;
      for (const row of block.rows)
        for (const c of row.cells) if (c.text.startsWith(text)) return { cell: c.id, row: row.id };
    }
    throw new Error(`no cell ${text}`);
  };
  return { paragraph, cell };
}

async function textOf(data: Uint8Array) {
  const zip = await JSZip.loadAsync(data);
  return documentXmlText(await zip.file("word/document.xml")!.async("string"));
}

/** The plan a well-behaved model returns for the form template. */
function goodPlan(blocks: BlockInfo[]): AIFillPlan {
  const { paragraph, cell } = ids(blocks);
  const s = FORM_SAMPLE;
  return aiFillPlanSchema.parse({
    version: 1,
    fills: [
      { block: cell(s.name).cell, refs: ["contact.fullName"] },
      { block: cell(s.location).cell, refs: ["contact.location"] },
      { block: cell(s.summary).cell, refs: ["summary"] },
      { block: cell(s.skill1).cell, refs: ["entry.item"] },
      { block: paragraph(s.employer1), refs: ["entry.subheading", "entry.dates"] },
      { block: paragraph(s.title1), refs: ["entry.heading"] },
      { block: paragraph(s.bullet1), refs: ["entry.text"] },
    ],
    clears: [cell(s.start).cell, cell(s.skill2).row],
    groups: [
      {
        source: "s0",
        per: "entry",
        blocks: [
          paragraph(s.employer1),
          paragraph(s.title1),
          paragraph(s.bullet1),
          paragraph(s.bullet2),
        ],
      },
      { source: "s1", per: "item", rows: [cell(s.skill1).row] },
    ],
  });
}

describe("DOCX template fill engine", () => {
  it("reads labels, sample values and paragraph segments from the template", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const employer = blocks.find(
      (b) => b.kind === "paragraph" && b.text.startsWith(FORM_SAMPLE.employer1),
    );
    expect(employer).toMatchObject({
      bold: true,
      segments: [FORM_SAMPLE.employer1, "Feb 2020 – May 2023"],
    });
    const bullet = blocks.find((b) => b.kind === "paragraph" && b.text === FORM_SAMPLE.bullet1);
    expect(bullet).toMatchObject({ numbered: true });
    expect(isLabelLike("Name:", true)).toBe(true);
    expect(isLabelLike("Years of Experience", true)).toBe(true);
    expect(isLabelLike("CANDIDATE INFORMATION", true)).toBe(true);
    expect(isLabelLike(FORM_SAMPLE.location, false)).toBe(false);
  });

  it("fills the template in place: labels kept, rows and entries repeated, sample person gone", async () => {
    const template = await makeFormTemplateDocx();
    const blocks = await readTemplateBlocks(template);
    const { plan, issues } = finalizeFillPlan(goodPlan(blocks), RESUME, blocks, source);
    // Education and Languages have no place in this template (reported, then added at the end).
    expect(issues).toEqual([
      'Content "s2.e0" is not placed in any block.',
      'Content "s3.e0" is not placed in any block.',
    ]);
    const shown = contentShownByFillPlan(RESUME, plan);
    const filled = await fillDocxTemplate(template, plan, shown);
    const text = await textOf(filled.data);

    // Labels and headings stay; values are the candidate's.
    expect(text).toContain("Name:\nRiley Synthetic");
    expect(text).toContain("Current Location:\nAvon, IN");
    expect(text).toContain("SUMMARY (Use this section for a candidate summary)\nForklift operator");
    // One skill per row, the sample "years" emptied.
    expect(text).toContain("Years of Experience\nReach truck\n\nPallet jack\n\nCycle count");
    // Experience: one copy of the sample entry per job, employer first, sentences as bullets.
    expect(text).toContain(
      "Example Bakeries Mar 2021 – Present\nForklift Operator\nInspected forklifts daily.\nLogged load weights each shift.",
    );
    expect(text).toContain(
      "Example Logistics Jan 2018 – Feb 2021\nWarehouse Associate\nPicked and packed orders",
    );
    // Content without a place goes to the end.
    expect(text).toMatch(/Additional Information\nEducation\n.*\nLanguages\nEnglish, Spanish/s);
    // Nothing of the sample person survives.
    for (const sample of Object.values(FORM_SAMPLE)) expect(text).not.toContain(sample);
    // The production validator agrees.
    expect(
      await validateDocx(filled.data, shown, {
        mode: "filled",
        forbiddenTexts: filled.forbiddenTexts,
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("removes sample values the plan forgot, but keeps labels", async () => {
    const template = await makeFormTemplateDocx();
    const blocks = await readTemplateBlocks(template);
    const forgetful = goodPlan(blocks);
    forgetful.fills = forgetful.fills.filter((fill) => fill.refs[0] !== "contact.location");
    forgetful.clears = forgetful.clears.filter(
      (id) => id !== ids(blocks).cell(FORM_SAMPLE.start).cell,
    );
    const { plan, warnings } = finalizeFillPlan(forgetful, RESUME, blocks, source);
    expect(warnings.find((w) => w.startsWith("Sample details"))).toMatch(/removed \(\d+\)/);
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const text = await textOf(filled.data);
    expect(text).not.toContain(FORM_SAMPLE.location);
    expect(text).toContain("Current Location:");
    expect(text).toContain("Can start within 2 weeks (yes/no)?");
  });

  it("repairs common plan mistakes deterministically", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const { paragraph, cell } = ids(blocks);
    const s = FORM_SAMPLE;
    const raw = goodPlan(blocks);
    // Group listed with a gap (its second sample bullet skipped, then cleared).
    raw.groups[0]!.blocks = [paragraph(s.employer1), paragraph(s.title1), paragraph(s.bullet1)];
    raw.clears.push(paragraph(s.bullet2));
    // A whole-section ref inside the per-item group instead of entry.item.
    raw.fills = raw.fills.map((fill) =>
      fill.block === cell(s.skill1).cell ? { ...fill, refs: ["s1.e0.bullets"] } : fill,
    );
    // The experience group named without its fields: they are read from the
    // sample entry's shape (dated line, title line, first bullet).
    const experience = new Set(raw.groups[0]!.blocks);
    raw.fills = raw.fills.filter((fill) => !experience.has(fill.block));
    // A group on empty spacer lines only cannot show anything: it is dropped.
    const spacer = blocks.find((b) => b.kind === "paragraph" && b.empty)!.id;
    raw.groups.push({ source: "s2", per: "entry", blocks: [spacer], rows: [] });

    const { plan, issues } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(plan.groups.map((group) => group.source)).toEqual(["s0", "s1"]);
    expect(issues).toContain(
      'Group for "s0" has no filled block; fill its blocks with "entry.*" refs and do not clear them.',
    );
    expect(plan.fills).toEqual(
      expect.arrayContaining([
        { block: paragraph(s.employer1), refs: ["entry.subheading+entry.location", "entry.dates"] },
        { block: paragraph(s.title1), refs: ["entry.heading"] },
        { block: paragraph(s.bullet1), refs: ["entry.text"] },
      ]),
    );
    expect(plan.additional).toContain("s2.e0");
    const filled = await fillDocxTemplate(
      await makeFormTemplateDocx(),
      plan,
      contentShownByFillPlan(RESUME, plan),
    );
    const text = await textOf(filled.data);
    expect(text).toContain("Years of Experience\nReach truck\n\nPallet jack\n\nCycle count");
    expect(text).not.toContain(s.bullet2);
    expect(text).toContain("Example Logistics Jan 2018 – Feb 2021");
  });

  it("never repeats content under another section's heading", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const { cell } = ids(blocks);
    const raw = goodPlan(blocks);
    // Experience repeated in the SKILLS table: wrong heading, so it goes to the end.
    raw.groups = raw.groups.filter((group) => group.source !== "s0");
    raw.groups.push({
      source: "s0",
      per: "entry",
      blocks: [],
      rows: [cell(FORM_SAMPLE.skill2).row],
    });
    raw.clears = raw.clears.filter((id) => id !== cell(FORM_SAMPLE.skill2).row);
    const { plan, issues } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(issues).toContain(
      'Group for "s0" sits under the heading "SKILLS", which is for other content.',
    );
    expect(plan.groups.map((group) => group.source)).not.toContain("s0");
    expect(plan.additional).toEqual(expect.arrayContaining(["s0.e0", "s0.e1"]));
  });

  it("points a group at the section its fills actually show", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const { cell } = ids(blocks);
    const raw = goodPlan(blocks);
    // Declared for skills (s1), filled with languages (s3): it repeats for s3.
    raw.fills = raw.fills.map((fill) =>
      fill.block === cell(FORM_SAMPLE.skill1).cell ? { ...fill, refs: ["s3"] } : fill,
    );
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(plan.groups.map((group) => group.source)).toEqual(["s0", "s3"]);
    expect(plan.additional).toContain("s1.e0");
  });

  it("splits lines joined by manual breaks, and keeps field labels", async () => {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: "Pat Example-Sample", bold: true }),
                    new TextRun({ text: "Location: Sampletown, ZZ", break: 1 }),
                  ],
                }),
                new Paragraph({ children: [new TextRun("Pay Rate: $36/hr on W2")] }),
                new Paragraph({ children: [new TextRun({ text: "Summary:", bold: true })] }),
                new Paragraph("Pat is a sample person with sample experience in sample things."),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const texts = blocks.map((b) => (b.kind === "paragraph" ? b.text : ""));
    expect(texts.slice(0, 2)).toEqual(["Pat Example-Sample", "Location: Sampletown, ZZ"]);

    const { paragraph } = ids(blocks);
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        { block: paragraph("Pat Example"), refs: ["contact.fullName"] },
        { block: paragraph("Location:"), refs: ["contact.location"] },
        // A summary in the pay-rate field is refused; the field is cleared.
        { block: paragraph("Pay Rate:"), refs: ["summary"] },
      ],
    });
    const { plan, issues } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(issues).toContain(
      'Block "' +
        paragraph("Pay Rate:") +
        '" is the "Pay Rate:" field, which does not fit summary; clear it instead.',
    );
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const text = await textOf(filled.data);
    expect(text).toMatch(/^Riley Synthetic\nLocation: Avon, IN\nPay Rate:\nSummary:\n/);
    expect(text).not.toMatch(/Sampletown|\$36|sample person/);
  });

  it("drops sample-content labels, shows the summary once, sweeps per-job labels", async () => {
    const { Document, Packer, Paragraph, TextRun, LevelFormat, AlignmentType, Tab } =
      await import("docx");
    const bullet = (text: string) =>
      new Paragraph({ numbering: { reference: "dots", level: 0 }, text });
    const bold = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
    const job = (employer: string, title: string, task: string) => [
      new Paragraph({
        children: [
          new TextRun({ text: employer, bold: true }),
          new TextRun({ children: [new Tab(), "2019 – 2021"] }),
        ],
      }),
      bold(title),
      bullet(task),
      new Paragraph("Project:"),
    ];
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          numbering: {
            config: [
              {
                reference: "dots",
                levels: [
                  {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                  },
                ],
              },
            ],
          },
          sections: [
            {
              children: [
                bold("Pat Example-Sample"),
                bold("Recruiter's Summary:"),
                new Paragraph("Pat is a strong fit for this sample role with sample skills."),
                bold("Summary:"),
                new Paragraph("Sample operator with many years of sample experience."),
                bold("Skills:"),
                bullet("Programming: Sample Lang, Other Sample Lang"),
                bold("Professional Experience:"),
                ...job("Sample Corp", "Sample Engineer", "Built sample things for sample users"),
                ...job(
                  "Other Sample Inc",
                  "Sample Manager",
                  "Managed sample teams across sample sites",
                ),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const { paragraph } = ids(blocks);
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        { block: paragraph("Pat Example"), refs: ["contact.fullName"] },
        { block: paragraph("Pat is a strong"), refs: ["summary"] },
        { block: paragraph("Sample operator"), refs: ["summary"] },
        { block: paragraph("Programming:"), refs: ["entry.item"] },
        { block: paragraph("Sample Corp"), refs: ["entry.subheading", "entry.dates"] },
        { block: paragraph("Sample Engineer"), refs: ["entry.heading"] },
        { block: paragraph("Built sample"), refs: ["entry.text"] },
      ],
      groups: [
        { source: "s1", per: "item", blocks: [paragraph("Programming:")] },
        {
          source: "s0",
          per: "entry",
          blocks: [
            paragraph("Sample Corp"),
            paragraph("Sample Engineer"),
            paragraph("Built sample"),
          ],
        },
      ],
    });
    const { plan, issues } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(issues.some((issue) => issue.startsWith("The summary is filled more than once"))).toBe(
      true,
    );
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const text = await textOf(filled.data);
    // The candidate summary goes to "Summary:", not the recruiter's box; shown once.
    expect(text).toMatch(/Recruiter's Summary:\nSummary:\nForklift operator/);
    expect(text.match(/Forklift operator with safe/g)).toHaveLength(1);
    // "Programming:" belonged to the sample person's bullet.
    expect(text).toContain("Skills:\nReach truck\nPallet jack\nCycle count\n");
    expect(text).not.toContain("Programming");
    // The second sample job and every "Project:" line are gone.
    expect(text).not.toMatch(/Sample|Project:/);
    expect(
      await validateDocx(filled.data, contentShownByFillPlan(RESUME, plan), {
        mode: "filled",
        forbiddenTexts: filled.forbiddenTexts,
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps section headings: split out of bullets, never filled, dropped only when emptied", async () => {
    const { Document, Packer, Paragraph, TextRun, LevelFormat, AlignmentType } =
      await import("docx");
    const bold = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          numbering: {
            config: [
              {
                reference: "dots",
                levels: [
                  {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                  },
                ],
              },
            ],
          },
          sections: [
            {
              children: [
                bold("Professional Summary:"),
                // A heading run into the last summary bullet after a line break.
                new Paragraph({
                  numbering: { reference: "dots", level: 0 },
                  children: [
                    new TextRun("Sample operator with sample experience."),
                    new TextRun({ text: "Skills:", bold: true, break: 1 }),
                  ],
                }),
                new Paragraph({ numbering: { reference: "dots", level: 0 }, text: "Sample skill" }),
                bold("Additional Experience"),
                new Paragraph("Other Sample Inc 2015 – 2017"),
                new Paragraph("Sample Clerk"),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const skills = blocks.find((b) => b.kind === "paragraph" && b.text === "Skills:");
    expect(skills).toMatchObject({ numbered: false });

    const { paragraph } = ids(blocks);
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        // No name line in this template: the heading must not take the name.
        { block: paragraph("Professional Summary:"), refs: ["contact.fullName"] },
        { block: paragraph("Sample operator"), refs: ["summary"] },
        { block: paragraph("Sample skill"), refs: ["entry.item"] },
      ],
      groups: [{ source: "s1", per: "item", blocks: [paragraph("Sample skill")] }],
      clears: [paragraph("Other Sample"), paragraph("Sample Clerk")],
    });
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(plan.insertName).toBe(true);
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const text = await textOf(filled.data);
    expect(text).toMatch(/Professional Summary:\nForklift operator/);
    expect(text).toContain("Skills:\nReach truck\n");
    // Its sample entries are gone, so the empty "Additional Experience" goes too.
    expect(text).not.toMatch(/Sample|Additional Experience/);
  });

  it("keeps the template's section breaks (a two-column skills list stays two columns)", async () => {
    const { Document, Packer, Paragraph, TextRun, LevelFormat, AlignmentType, SectionType } =
      await import("docx");
    const bullet = (text: string) =>
      new Paragraph({ numbering: { reference: "dots", level: 0 }, text });
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          numbering: {
            config: [
              {
                reference: "dots",
                levels: [
                  {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                  },
                ],
              },
            ],
          },
          sections: [
            {
              children: [
                new Paragraph({ children: [new TextRun({ text: "Pat Example", bold: true })] }),
                new Paragraph({ children: [new TextRun({ text: "Skills:", bold: true })] }),
                // The empty bullet that ends the one-column section.
                new Paragraph({ numbering: { reference: "dots", level: 0 }, children: [] }),
              ],
            },
            {
              properties: { type: SectionType.CONTINUOUS, column: { count: 2, space: 720 } },
              children: [bullet("Sample Skill One"), bullet("Sample Skill Two")],
            },
            {
              properties: { type: SectionType.CONTINUOUS },
              children: [
                new Paragraph({ children: [new TextRun({ text: "Education:", bold: true })] }),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const { paragraph } = ids(blocks);
    const carrier = blocks.find((b) => b.kind === "paragraph" && b.sectionEnd && b.empty)!;
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        { block: paragraph("Pat Example"), refs: ["contact.fullName"] },
        // The plan puts the skills into the blank carrier bullet.
        { block: carrier.id, refs: ["entry.item"] },
      ],
      groups: [{ source: "s1", per: "item", blocks: [carrier.id] }],
      clears: [paragraph("Sample Skill One"), paragraph("Sample Skill Two")],
    });
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const xml = await (
      await JSZip.loadAsync(filled.data)
    )
      .file("word/document.xml")!
      .async("string");
    // Paragraph texts in order, "|" marking where a section ends.
    const flow = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map(
        (m) =>
          [...m[0].matchAll(/<w:t[^>]*>([^<]*)/g)].map((a) => a[1]).join("") +
          (m[0].includes("<w:sectPr") ? "|" : ""),
      )
      .join("\n");
    // Section 1 ends with "Skills:"; the skills fill the two-column section 2.
    expect(flow).toMatch(
      /^Riley Synthetic\nSkills:\|\nReach truck\nPallet jack\nCycle count\|\nEducation:/,
    );
    const breaks = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map((m) => m[0]);
    expect(breaks).toHaveLength(3);
    expect(breaks[1]).toContain('w:num="2"');
  });

  it("shows each job once when the plan's repeat group spans several sample jobs", async () => {
    const { Document, Packer, Paragraph, TextRun, LevelFormat, AlignmentType } =
      await import("docx");
    const bold = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
    const bullet = (text: string) =>
      new Paragraph({ numbering: { reference: "dots", level: 0 }, text });
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          numbering: {
            config: [
              {
                reference: "dots",
                levels: [
                  {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                  },
                ],
              },
            ],
          },
          sections: [
            {
              children: [
                bold("Pat Example-Sample"),
                bold("Experience:"),
                bold("First Sample Corp"),
                bold("First Sample Role"),
                bullet("First sample duty"),
                bullet("Second sample duty"),
                new Paragraph(""),
                bold("Second Sample Corp"),
                bold("Second Sample Role"),
                bullet("Third sample duty"),
                new Paragraph(""),
                bold("Third Sample Corp"),
                bold("Third Sample Role"),
                bullet("Fourth sample duty"),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const { paragraph } = ids(blocks);
    const blanks = blocks.filter((b) => b.kind === "paragraph" && b.empty).map((b) => b.id);
    // The plan spans all three sample jobs and fills each with explicit entry references.
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        { block: paragraph("Pat Example"), refs: ["contact.fullName"] },
        { block: paragraph("First Sample Corp"), refs: ["s0.e0.subheading"] },
        { block: paragraph("First Sample Role"), refs: ["s0.e0.heading"] },
        { block: paragraph("First sample duty"), refs: ["s0.e0.description"] },
        { block: paragraph("Second Sample Corp"), refs: ["s0.e1.subheading"] },
        { block: paragraph("Second Sample Role"), refs: ["s0.e1.heading"] },
        { block: paragraph("Third sample duty"), refs: ["s0.e1.description"] },
      ],
      clears: [paragraph("Second sample duty"), paragraph("Third Sample"), paragraph("Fourth")],
      groups: [
        {
          source: "s0",
          per: "entry",
          blocks: [
            paragraph("First Sample Corp"),
            paragraph("First Sample Role"),
            paragraph("First sample duty"),
            paragraph("Second sample duty"),
            blanks[0]!,
            paragraph("Second Sample Corp"),
            paragraph("Second Sample Role"),
            paragraph("Third sample duty"),
          ],
        },
      ],
    });
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    const shown = contentShownByFillPlan(RESUME, plan);
    const filled = await fillDocxTemplate(template, plan, shown);
    const text = await textOf(filled.data);
    // Each real job appears exactly once, with a blank line between them.
    expect(text.match(/Example Bakeries/g)).toHaveLength(1);
    expect(text.match(/Example Logistics/g)).toHaveLength(1);
    expect(text).toMatch(/Logged load weights[^\n]*\n\nExample Logistics/);
    expect(text).not.toMatch(/Sample/);
    expect(
      await validateDocx(filled.data, shown, {
        mode: "filled",
        forbiddenTexts: filled.forbiddenTexts,
      }),
    ).toMatchObject({ ok: true });
  });

  it("flags content that appears more often than the resume has it", async () => {
    const { Document, Packer, Paragraph } = await import("docx");
    const bytes = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph("Riley Synthetic"),
                new Paragraph("Picked and packed orders for the warehouse team."),
                new Paragraph("Picked and packed orders for the warehouse team."),
              ],
            },
          ],
        }),
      ),
    );
    const content: ResumeContent = {
      ...RESUME,
      summary: undefined,
      sections: [
        {
          kind: "experience",
          title: "Experience",
          entries: [
            { heading: "Picker", bullets: ["Picked and packed orders for the warehouse team."] },
          ],
        },
      ],
    };
    const result = await validateDocx(bytes, content, { mode: "filled" });
    expect(result.problems.join(" ")).toMatch(/more than once/);
  });

  it("keeps the blank line between entries and puts dates at the right margin", async () => {
    const { Document, Packer, Paragraph, TextRun, Tab, LevelFormat, AlignmentType } =
      await import("docx");
    const bold = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
    const template = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          numbering: {
            config: [
              {
                reference: "dots",
                levels: [
                  {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                  },
                ],
              },
            ],
          },
          sections: [
            {
              children: [
                bold("Pat Example-Sample"),
                bold("Experience:"),
                // The date is lined up with a run of tabs, as many templates do.
                new Paragraph({
                  children: [
                    new TextRun({ text: "Sample Corp", bold: true }),
                    new TextRun({
                      children: [new Tab(), new Tab(), new Tab(), new Tab(), "2019 – 2021"],
                    }),
                  ],
                }),
                bold("Sample Engineer"),
                new Paragraph({
                  numbering: { reference: "dots", level: 0 },
                  text: "Built sample things",
                }),
                new Paragraph(""),
                new Paragraph({
                  children: [
                    new TextRun({ text: "Other Sample Inc", bold: true }),
                    new TextRun({ children: [new Tab(), new Tab(), "2015 – 2017"] }),
                  ],
                }),
                bold("Sample Manager"),
                new Paragraph({
                  numbering: { reference: "dots", level: 0 },
                  text: "Managed sample teams",
                }),
              ],
            },
          ],
        }),
      ),
    );
    const blocks = await readTemplateBlocks(template);
    const { paragraph } = ids(blocks);
    const blank = blocks.find((b) => b.kind === "paragraph" && b.empty)!;
    const raw = aiFillPlanSchema.parse({
      version: 1,
      fills: [
        { block: paragraph("Pat Example"), refs: ["contact.fullName"] },
        { block: paragraph("Sample Corp"), refs: ["entry.subheading", "entry.dates"] },
        { block: paragraph("Sample Engineer"), refs: ["entry.heading"] },
        { block: paragraph("Built sample"), refs: ["entry.text"] },
      ],
      // The plan clears the blank separator with the sample entry.
      clears: [
        blank.id,
        paragraph("Other Sample"),
        paragraph("Sample Manager"),
        paragraph("Managed sample"),
      ],
      groups: [
        {
          source: "s0",
          per: "entry",
          blocks: [
            paragraph("Sample Corp"),
            paragraph("Sample Engineer"),
            paragraph("Built sample"),
            blank.id,
          ],
        },
      ],
    });
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    const filled = await fillDocxTemplate(template, plan, contentShownByFillPlan(RESUME, plan));
    const xml = await (
      await JSZip.loadAsync(filled.data)
    )
      .file("word/document.xml")!
      .async("string");
    const lines = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => m[0]);
    const textOf = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)/g)].map((a) => a[1]).join("");
    const at = lines.findIndex((p) => textOf(p).startsWith("Example Logistics"));
    // A blank line separates the two jobs.
    expect(textOf(lines[at - 1]!)).toBe("");
    expect(textOf(lines[at - 2]!)).toContain("Logged load weights");
    // One tab and a right-aligned stop at the text width (A4 default: 9026 twips).
    for (const p of lines.filter((q) => /Example (Bakeries|Logistics)/.test(textOf(q)))) {
      expect(p.match(/<w:tab\/>/g)).toHaveLength(1);
      expect(p).toMatch(/<w:tabs><w:tab w:val="right" w:pos="\d{4,5}"\/><\/w:tabs>/);
    }
  });

  it("lists details the plan left out under Additional Information when asked to", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const raw = goodPlan(blocks);
    const template = await makeFormTemplateDocx();
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    const shown = contentShownByFillPlan(RESUME, plan);
    const filled = await fillDocxTemplate(template, plan, shown, ["A detail with no place"]);
    const text = await textOf(filled.data);
    expect(text).toMatch(/Additional Information\n(?:[^\n]*\n)*•? ?A detail with no place/);
  });

  it("shows a single date column as the whole date range", async () => {
    const blocks = await readTemplateBlocks(await makeFormTemplateDocx());
    const raw = goodPlan(blocks);
    const { paragraph } = ids(blocks);
    raw.fills = raw.fills.map((fill) =>
      fill.block === paragraph(FORM_SAMPLE.employer1)
        ? { ...fill, refs: ["entry.subheading", "entry.endDate"] }
        : fill,
    );
    const { plan } = finalizeFillPlan(raw, RESUME, blocks, source);
    expect(
      plan.fills.find((fill) => fill.block === paragraph(FORM_SAMPLE.employer1))!.refs,
    ).toEqual(["entry.subheading", "entry.dates"]);
  });

  it("uses only sample values (not field labels) from the template analysis", () => {
    expect(
      sampleValues(["Name:", "School | Degree", "[Candidate Name]", "Lauren Wentworth", "Yes"]),
    ).toEqual(["Lauren Wentworth"]);
    expect(comparable(expectedTexts(RESUME).join(" "))).toContain("Riley Synthetic");
  });
});
