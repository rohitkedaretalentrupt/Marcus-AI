import JSZip from "jszip";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";

import type { ResumeContent } from "@/lib/documents/resume-content";
import { contentShownByPlan, planKindForSection } from "@/lib/formatting/content-refs";
import { finalizePlan } from "@/lib/formatting/finalize-plan";
import { aiFormattingPlanSchema, type SectionLayout } from "@/lib/formatting/plan";
import {
  clientTemplateStructureSchema,
  type ClientTemplateStructure,
} from "@/lib/templates/structure";
import { SYNTHETIC_RESUMES } from "@test/fixtures/synthetic-resumes";

import { createDocxRenderer } from "./docx-renderer";
import {
  documentXmlText,
  expectedTexts,
  structuralProblems,
  validateDocx,
} from "./docx-validation";
import { comparable } from "./text";

/*
 * DOCX quality matrix: every synthetic resume × every template style is
 * rendered and checked by (1) the production validator, (2) an independent
 * reader (mammoth) for content, and (3) layout-specific assertions.
 */

const base = {
  version: 1,
  summary: "Synthetic test template.",
  header: { fields: ["fullName", "email", "phone"], alignment: "left" },
  placeholders: [],
  notes: [],
};
const sections = (headings: Record<string, string>) =>
  Object.entries(headings).map(([kind, heading]) => ({ kind, heading, contentHints: [] }));

/** Template analyses as Phase 7 would produce them for typical client templates. */
const TEMPLATES: Record<
  string,
  { structure: ClientTemplateStructure; layouts?: Partial<Record<string, SectionLayout>> }
> = {
  simplePdf: {
    structure: clientTemplateStructureSchema.parse({
      ...base,
      sections: sections({
        summary: "PROFILE",
        experience: "EXPERIENCE",
        education: "EDUCATION",
        skills: "SKILLS",
      }),
      layout: { columns: 1, pageSize: "letter", margins: "normal", dateAlignment: "right" },
      typography: { headingCase: "upper", bodyFont: "Arial", baseSizePt: 10.5, headingSizePt: 12 },
    }),
  },
  simpleDocx: {
    structure: clientTemplateStructureSchema.parse({
      ...base,
      sections: sections({
        summary: "Summary",
        experience: "Employment History",
        education: "Education",
      }),
      layout: { columns: 1, pageSize: "a4", margins: "wide", dateAlignment: "inline" },
      typography: { headingCase: "title", bodyFont: "Calibri", baseSizePt: 11 },
    }),
  },
  twoColumns: {
    structure: clientTemplateStructureSchema.parse({
      ...base,
      header: { fields: ["fullName", "email"], alignment: "center" },
      sections: sections({
        skills: "Key Skills",
        experience: "Career History",
        education: "Education",
      }),
      layout: { columns: 2, pageSize: "a4", margins: "narrow", dateAlignment: "right" },
      typography: { headingCase: "upper" },
    }),
  },
  tables: {
    structure: clientTemplateStructureSchema.parse({
      ...base,
      sections: sections({ experience: "Employment", education: "Qualifications" }),
      layout: { columns: 1, pageSize: "letter", margins: "normal", dateAlignment: "left" },
      typography: { headingCase: "sentence", headingFont: "Georgia" },
    }),
    layouts: { experience: "table", education: "table" },
  },
  headingStyles: {
    structure: clientTemplateStructureSchema.parse({
      ...base,
      sections: sections({ experience: "Professional Experience", projects: "Selected Projects" }),
      layout: {
        columns: 1,
        pageSize: "letter",
        margins: "narrow",
        dateAlignment: "right",
        sectionDividers: true,
        bulletStyle: "square",
      },
      typography: { headingCase: "title", headingSizePt: 14, baseSizePt: 9.5 },
    }),
  },
};

const SIDE_KINDS = new Set(["skills", "languages", "certifications", "awards"]);
const DEFAULT_LAYOUT: Record<string, SectionLayout> = {
  skills: "inline",
  languages: "inline",
  summary: "paragraph",
};

/** What a well-behaved model would return: one plan section per resume section. */
function simulatedPlan(content: ResumeContent, template: (typeof TEMPLATES)[string]) {
  const headingFor = (kind: string, fallback: string) =>
    template.structure.sections.find((section) => section.kind === kind)?.heading ?? fallback;
  const planSections = [
    ...(content.summary
      ? [
          {
            heading: headingFor("summary", "Summary"),
            kind: "summary",
            layout: "paragraph",
            sources: ["summary"],
          },
        ]
      : []),
    ...content.sections.map((section, i) => {
      const kind = planKindForSection(content, i);
      return {
        heading: headingFor(kind, section.title),
        kind,
        layout: template.layouts?.[kind] ?? DEFAULT_LAYOUT[kind] ?? "entries",
        sources: [`s${i}`],
        column: SIDE_KINDS.has(kind) ? "side" : "main",
      };
    }),
  ];
  return aiFormattingPlanSchema.parse({
    version: 1,
    header: { fields: ["fullName", "headline", "email", "phone", "location", "links"] },
    sections: planSections.filter((section) => section.sources.length > 0),
    footer: { pageNumbers: true },
  });
}

async function renderCase(content: ResumeContent, template: (typeof TEMPLATES)[string]) {
  const { plan, issues } = finalizePlan(
    simulatedPlan(content, template),
    content,
    template.structure,
    {
      resumeFileId: "f",
      templateId: "t",
      templateAnalyzedAt: null,
      engineVersion: 1,
    },
  );
  // As in production: contact details the template has no place for are not part of the document.
  const shown = contentShownByPlan(content, plan);
  const { data } = await createDocxRenderer().render({ content: shown, plan });
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("word/document.xml")!.async("string");
  return { plan, issues, data, xml, shown };
}

const cases = Object.keys(SYNTHETIC_RESUMES).flatMap((resume) =>
  Object.keys(TEMPLATES).map((template) => [resume, template] as const),
);

describe("DOCX quality matrix (synthetic resumes × template styles)", () => {
  it.each(cases)("%s × %s", async (resumeName, templateName) => {
    const content = SYNTHETIC_RESUMES[resumeName]!;
    const template = TEMPLATES[templateName]!;
    const { plan, issues, data, xml, shown } = await renderCase(content, template);

    // The simulated plan is complete and follows the template.
    expect(issues.filter((issue) => !issue.includes("order"))).toEqual([]);

    // 1. Production validator (package, content, links, structure).
    expect(await validateDocx(data, shown)).toEqual({ ok: true, problems: [] });

    // 2. An independent DOCX reader opens the file and finds every resume fact.
    const { value: readBack } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    const independent = comparable(readBack);
    for (const expected of expectedTexts(shown)) expect(independent).toContain(expected);

    // Contact details are shown only where the template has them.
    const fields = new Set<string>(template.structure.header.fields);
    const { contact } = content;
    for (const [field, value] of [
      ["email", contact.email],
      ["phone", contact.phone],
      ["location", contact.location],
    ] as const) {
      if (value && !fields.has(field)) expect(documentXmlText(xml)).not.toContain(value);
    }

    // 3. No placeholder junk or dangling separators from missing fields.
    const text = documentXmlText(xml);
    expect(text).not.toMatch(/undefined|null|\[object|NaN/);
    expect(text).not.toMatch(/^\s*[|•·–,]|[|•·–,]\s*$|\|\s*\|/m);

    // Dates: right-aligned via a right tab stop inside the usable width.
    if (
      plan.entries.datePosition === "right" &&
      content.sections.some((s) => s.entries.some((e) => e.endDate))
    ) {
      const pageWidth = Number(/<w:pgSz w:w="(\d+)"/.exec(xml)![1]);
      const tabs = [...xml.matchAll(/<w:tab w:val="right" w:pos="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      expect(tabs.length).toBeGreaterThan(0);
      for (const position of tabs) expect(position).toBeLessThan(pageWidth);
    }
    // Two columns only when there is side content; otherwise a single column.
    const hasSide = plan.sections.some((section) => section.column === "side");
    if (plan.page.columns === 2 && hasSide) expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
    if (plan.page.columns === 2 && !hasSide) expect(xml).not.toContain("<w:tbl>");
  });

  it("missing optional information leaves no empty contact line or blank lines", async () => {
    const { xml } = await renderCase(SYNTHETIC_RESUMES.missingOptional!, TEMPLATES.simplePdf!);
    const paragraphs = documentXmlText(xml).split("\n");
    expect(paragraphs[0]).toBe("Sam Minimal");
    expect(paragraphs.filter((line) => line.trim() === "").length).toBeLessThanOrEqual(1);
  });

  it("long resumes are not shrunk to fit: same font sizes as a one-page resume", async () => {
    const sizes = async (name: string) =>
      [
        ...(await renderCase(SYNTHETIC_RESUMES[name]!, TEMPLATES.simplePdf!)).xml.matchAll(
          /<w:sz w:val="(\d+)"/g,
        ),
      ]
        .map((m) => m[1])
        .filter((size, i, all) => all.indexOf(size) === i)
        .sort()
        .join();
    expect(await sizes("longHistory")).toEqual(await sizes("onePage"));
  });
});

describe("structuralProblems", () => {
  it.each([
    ["malformed XML", "<w:body><w:p></w:body>"],
    [
      "broken table",
      "<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc></w:tc></w:tr></w:tbl>",
    ],
    ["broken hyperlink", '<w:hyperlink r:id="rId99"></w:hyperlink>'],
    ["unreadably small text", '<w:sz w:val="10"/>'],
    ["blank page", "<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>"],
    ["blank space", "<w:p></w:p><w:p></w:p><w:p></w:p>"],
  ])("detects %s", (problem, xml) => {
    expect(structuralProblems(xml, "")).toContain(problem);
  });
});
