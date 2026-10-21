import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { contentShownByPlan } from "@/lib/formatting/content-refs";
import { finalizePlan } from "@/lib/formatting/finalize-plan";
import type { FormattingPlan } from "@/lib/formatting/plan";
import { clientTemplateStructureSchema } from "@/lib/templates/structure";
import { parsePlan, SAMPLE_AI_PLAN, SAMPLE_RESUME_CONTENT } from "@test/fixtures/formatting";
import { SAMPLE_TEMPLATE_STRUCTURE } from "@test/fixtures/template-structure";

import { createDocxRenderer } from "./docx-renderer";
import { documentXmlText, validateDocx } from "./docx-validation";

const template = clientTemplateStructureSchema.parse(SAMPLE_TEMPLATE_STRUCTURE);
const source = { resumeFileId: "f", templateId: "t", templateAnalyzedAt: null, engineVersion: 1 };

async function planFor(raw: unknown = SAMPLE_AI_PLAN, structure = template) {
  return finalizePlan(await parsePlan(raw), SAMPLE_RESUME_CONTENT, structure, source).plan;
}

async function render(plan: FormattingPlan, content = SAMPLE_RESUME_CONTENT) {
  const { data, mimeType } = await createDocxRenderer().render({ content, plan });
  const zip = await JSZip.loadAsync(data);
  const read = (name: string) => zip.file(name)?.async("string") ?? Promise.resolve("");
  return {
    data,
    mimeType,
    xml: await read("word/document.xml"),
    rels: await read("word/_rels/document.xml.rels"),
    styles: await read("word/styles.xml"),
    numbering: await read("word/numbering.xml"),
    footer: await read("word/footer1.xml"),
  };
}

describe("DOCX renderer", () => {
  it("renders a valid Word package containing every piece of resume content", async () => {
    const doc = await render(await planFor());
    expect(doc.mimeType).toContain("wordprocessingml.document");
    expect(await validateDocx(doc.data, SAMPLE_RESUME_CONTENT)).toEqual({ ok: true, problems: [] });

    const text = documentXmlText(doc.xml);
    // Template headings, upper-cased per the template; resume facts verbatim.
    expect(text).toContain("PROFESSIONAL SUMMARY");
    // No template section for Skills/Awards/Languages: listed under one heading at the end.
    expect(text).toContain(
      "ADDITIONAL INFORMATION\nSkills\nSQL\nPython\nTableau\nPower BI\nAwards",
    );
    expect(text).toContain("Senior Data Analyst Feb 2021 – Present");
    expect(text).toContain("Owned weekly KPI reporting <for> 12 clinics.");
    // Text is XML-escaped, never interpreted as markup.
    expect(doc.xml).toContain("&lt;for&gt;");
  });

  it("renders bullets as real Word numbering with the plan's symbol", async () => {
    const doc = await render(await planFor({ ...SAMPLE_AI_PLAN, bullets: { symbol: "▪" } }));
    // 2 Contoso bullets + the Fabrikam sentence (the template shows experience as bullets)
    // + Skills (4), Awards (1) and Languages (2) under "Additional Information".
    expect(doc.xml.match(/<w:numPr>/g)?.length).toBe(10);
    expect(doc.numbering).toContain('w:val="▪"');
  });

  it("renders contact links as external hyperlinks (and email as mailto)", async () => {
    const doc = await render(await planFor());
    expect(doc.rels).toContain('Target="https://www.linkedin.com/in/sam-rivera-test/"');
    expect(doc.rels).toContain('Target="mailto:sam.rivera@example.test"');
    expect(doc.xml.match(/<w:hyperlink /g)?.length).toBe(3);
    expect(documentXmlText(doc.xml)).toContain("linkedin.com/in/sam-rivera-test");
  });

  it("applies typography, colours, dividers and right-aligned dates", async () => {
    const doc = await render(await planFor());
    expect(doc.styles).toContain('w:ascii="Arial"'); // body font
    expect(doc.xml).toContain('w:ascii="Georgia"'); // heading font
    expect(doc.styles).toMatch(/<w:sz w:val="20"\/>/); // 10 pt body (template)
    expect(doc.xml).toMatch(/<w:sz w:val="26"\/>/); // 13 pt headings (template)
    expect(doc.xml).toContain('w:color w:val="1F3864"');
    expect(doc.xml).toMatch(/<w:pBdr><w:bottom /); // dividers under headings
    expect(doc.xml).toMatch(/<w:tab w:val="right"/);
    expect(doc.xml).toContain("<w:tab/>");
  });

  it("applies page size, margins and footer page numbers", async () => {
    const doc = await render(await planFor());
    expect(doc.xml).toMatch(/<w:pgSz w:w="11906" w:h="16838"/); // A4 from the template
    expect(doc.xml).toMatch(/<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/);
    expect(doc.footer).toContain("PAGE");
  });

  it("clamps unreadable values (tiny fonts, extreme margins, white text)", async () => {
    const plain = clientTemplateStructureSchema.parse({
      ...SAMPLE_TEMPLATE_STRUCTURE,
      layout: { columns: 1 },
      typography: {},
    });
    const plan = await planFor(
      {
        ...SAMPLE_AI_PLAN,
        page: { marginsInches: { top: 0, right: 3, bottom: 0, left: 3 } },
        typography: { bodySizePt: 5, textColor: "#FFFFFF" },
        spacing: { lineSpacing: 3, sectionBeforePt: 48 },
      },
      plain,
    );
    const doc = await render(plan);
    expect(doc.styles).toMatch(/<w:sz w:val="18"\/>/); // clamped to 9 pt
    expect(doc.styles).toContain('w:color w:val="1A1A1A"'); // white text rejected
    expect(doc.xml).toMatch(/<w:pgMar w:top="576" w:right="2160" w:bottom="576" w:left="2160"/);
    expect(doc.xml).not.toMatch(/w:line="(?:[4-9]\d\d|\d{4,})"/); // ≤ 1.5 line spacing
  });

  it("renders two columns and table layouts without nested tables", async () => {
    const twoColumn = clientTemplateStructureSchema.parse({
      ...SAMPLE_TEMPLATE_STRUCTURE,
      layout: { ...SAMPLE_TEMPLATE_STRUCTURE.layout, columns: 2 },
    });
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      sections: { column?: string; layout?: string }[];
    };
    raw.sections[3]!.column = "side";
    raw.sections[5]!.column = "side";
    raw.sections[1]!.layout = "table";
    const doc = await render(await planFor(raw, twoColumn));
    expect(doc.xml.match(/<w:tbl>/g)?.length).toBe(1);
    expect(await validateDocx(doc.data, SAMPLE_RESUME_CONTENT)).toMatchObject({ ok: true });

    const single = await render(await planFor(raw));
    expect(single.xml.match(/<w:tbl>/g)?.length).toBe(1); // the experience table
    expect(await validateDocx(single.data, SAMPLE_RESUME_CONTENT)).toMatchObject({ ok: true });
  });

  it("honours page breaks", async () => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      sections: { pageBreakBefore?: boolean }[];
    };
    raw.sections[2]!.pageBreakBefore = true;
    const doc = await render(await planFor(raw));
    expect(doc.xml.match(/<w:pageBreakBefore\/>/g)?.length).toBe(1);
  });

  it("strips characters that would corrupt the XML and never interprets markup", async () => {
    const content = structuredClone(SAMPLE_RESUME_CONTENT);
    content.sections[0]!.entries[0]!.bullets = [
      "Bell\u0007 character and\u0000 null",
      '</w:t></w:r><w:r><w:t>injected"&',
    ];
    const plan = finalizePlan(await parsePlan(), content, template, source).plan;
    const doc = await render(plan, content);
    expect(doc.xml).not.toMatch(/[\u0000\u0007]/);
    expect(doc.xml).toContain("&lt;/w:t&gt;&lt;/w:r&gt;");
    expect(await validateDocx(doc.data, content)).toEqual({ ok: true, problems: [] });
  });

  it("is deterministic: the same input produces the same document body", async () => {
    const plan = await planFor();
    expect((await render(plan)).xml).toBe((await render(plan)).xml);
  });
});

describe("DOCX validation", () => {
  it("fails when resume content is missing from the document", async () => {
    const doc = await render(await planFor());
    const more = structuredClone(SAMPLE_RESUME_CONTENT);
    more.sections[0]!.entries[0]!.bullets.push("Mentored three junior analysts");
    expect(await validateDocx(doc.data, more)).toEqual({
      ok: false,
      problems: ["missing 1 text item(s)"],
      missingTexts: ["Mentored three junior analysts"],
    });
  });

  it.each([
    ["an empty file", new Uint8Array()],
    ["a non-ZIP file", new TextEncoder().encode("%PDF-1.7 not a docx")],
    ["a damaged ZIP", new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0])],
  ])("rejects %s", async (_name, data) => {
    expect((await validateDocx(data, SAMPLE_RESUME_CONTENT)).ok).toBe(false);
  });

  it("rejects a package that is not a Word document", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("_rels/.rels", "<Relationships/>");
    zip.file("word/document.xml", "<w:document><w:body/></w:document>");
    const data = await zip.generateAsync({ type: "uint8array" });
    const result = await validateDocx(data, SAMPLE_RESUME_CONTENT);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("not a Word document");
  });

  it("rejects hyperlinks that are not the resume's own links", async () => {
    const doc = await render(await planFor());
    const other = structuredClone(SAMPLE_RESUME_CONTENT);
    other.contact.links = [{ label: "Website", url: "https://other.example.test/" }];
    const result = await validateDocx(doc.data, other);
    expect(result.problems).toEqual(
      expect.arrayContaining(["unexpected hyperlink target", "missing hyperlink"]),
    );
  });
});

describe("template rules for the generated resume", () => {
  /** Like the Zillow template: header shows name + location; experience is bulleted. */
  const strict = clientTemplateStructureSchema.parse({
    ...SAMPLE_TEMPLATE_STRUCTURE,
    header: { fields: ["fullName", "location"], alignment: "center" },
    sections: [
      { kind: "summary", heading: "Summary:", contentHints: ["paragraph block", "no bullets"] },
      { kind: "education", heading: "Education:", contentHints: ["bulleted list"] },
      {
        kind: "experience",
        heading: "Professional Experience:",
        contentHints: ["bulleted accomplishments with hanging indent"],
      },
    ],
  });
  const paragraphResume = structuredClone(SAMPLE_RESUME_CONTENT);
  paragraphResume.sections[0]!.entries[1]!.description =
    "Owned weekly KPI reporting for 12 clinics. Cut report time by 40% e.g. via SQL views. Trained 3 analysts.";

  async function strictPlan() {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      sections: { heading: string }[];
    };
    raw.sections[0]!.heading = "Summary:";
    raw.sections[1]!.heading = "Professional Experience:";
    raw.sections[2]!.heading = "Education:";
    return finalizePlan(await parsePlan(raw), paragraphResume, strict, source);
  }

  it("shows only the contact details the template has (the name always)", async () => {
    const { plan, warnings } = await strictPlan();
    expect(plan.header.fields).toEqual(["fullName", "location"]);
    expect(warnings).toContain(
      "Contact details the template has no place for were left out (job title, email, phone, links).",
    );
    const shown = contentShownByPlan(paragraphResume, plan);
    expect(shown.contact).toEqual({ fullName: "Sam Rivera", location: "Denver, CO", links: [] });

    const doc = await render(plan, shown);
    const text = documentXmlText(doc.xml);
    expect(text).not.toContain("sam.rivera@example.test");
    expect(text).not.toContain("555-010-4477");
    expect(doc.rels).not.toContain("linkedin.com");
    expect(await validateDocx(doc.data, shown)).toEqual({ ok: true, problems: [] });
  });

  it("turns running text into bullet points where the template uses bullets", async () => {
    const { plan } = await strictPlan();
    const section = (heading: string) => plan.sections.find((s) => s.heading === heading)!;
    expect(section("Professional Experience:").textAsBullets).toBe(true);
    expect(section("Summary:").textAsBullets).toBe(false);

    const shown = contentShownByPlan(paragraphResume, plan);
    const doc = await render(plan, shown);
    const paragraphs = doc.xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
    const bulleted = paragraphs
      .filter((p) => p.includes("<w:numPr>"))
      .map((p) => documentXmlText(p));
    // One bullet per sentence, wording unchanged ("e.g." is not a sentence end).
    expect(bulleted).toEqual(
      expect.arrayContaining([
        "Owned weekly KPI reporting for 12 clinics.",
        "Cut report time by 40% e.g. via SQL views.",
        "Trained 3 analysts.",
      ]),
    );
    // The summary stays a paragraph.
    expect(bulleted).not.toContain(SAMPLE_RESUME_CONTENT.summary);
    expect(await validateDocx(doc.data, shown)).toEqual({ ok: true, problems: [] });
  });

  it("adds content the template has no section for at the end, as labelled bullets", async () => {
    const { plan } = await strictPlan();
    expect(plan.sections.map((s) => s.heading)).toEqual([
      "Summary:",
      "Education:",
      "Professional Experience:",
      "Additional Information",
    ]);
    const doc = await render(plan, contentShownByPlan(paragraphResume, plan));
    const text = documentXmlText(doc.xml);
    expect(text).toContain(
      "ADDITIONAL INFORMATION\nSkills\nSQL\nPython\nTableau\nPower BI\nAwards\nAnalyst of the Year (2022)\nLanguages\nEnglish (native)\nSpanish (fluent)",
    );
  });
});
