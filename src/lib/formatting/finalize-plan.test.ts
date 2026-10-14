import { describe, expect, it } from "vitest";

import { clientTemplateStructureSchema } from "@/lib/templates/structure";
import { parsePlan, SAMPLE_AI_PLAN, SAMPLE_RESUME_CONTENT } from "@test/fixtures/formatting";
import { SAMPLE_TEMPLATE_STRUCTURE } from "@test/fixtures/template-structure";

import { requiredRefs, toAIResumeView } from "./content-refs";
import { finalizePlan } from "./finalize-plan";
import { aiFormattingPlanSchema } from "./plan";

const template = clientTemplateStructureSchema.parse(SAMPLE_TEMPLATE_STRUCTURE);
const source = {
  resumeFileId: "file1",
  templateId: "tpl1",
  templateAnalyzedAt: null,
  engineVersion: 1,
};
const finalize = async (raw: unknown = SAMPLE_AI_PLAN) =>
  finalizePlan(await parsePlan(raw), SAMPLE_RESUME_CONTENT, template, source);
const placed = (plan: { sections: { sources: string[] }[] }) =>
  plan.sections.flatMap((section) => section.sources);

describe("FormattingPlan schema", () => {
  it("accepts a plan and fills presentation defaults", async () => {
    const plan = await parsePlan();
    expect(plan.page).toMatchObject({ size: "letter", columns: 1 });
    expect(plan.typography.headingColor).toBe("1F3864");
    expect(plan.bullets.symbol).toBe("•");
  });

  it.each([
    ["an unknown reference format", { sources: ["experience"] }],
    ["markup in a font name", { typographyFont: "<w:r>Arial" }],
  ])("rejects %s", (_name, change) => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as Record<string, unknown> & {
      sections: { sources: string[] }[];
      typography: Record<string, unknown>;
    };
    if ("sources" in change) raw.sections[0]!.sources = change.sources;
    if ("typographyFont" in change) raw.typography.bodyFont = change.typographyFont;
    expect(aiFormattingPlanSchema.safeParse(raw).success).toBe(false);
  });

  it("drops fields it does not define (no raw XML/HTML can be carried)", async () => {
    const plan = await parsePlan({ ...SAMPLE_AI_PLAN, xml: "<w:p/>", html: "<script>" });
    expect(plan).not.toHaveProperty("xml");
    expect(plan).not.toHaveProperty("html");
  });
});

describe("toAIResumeView", () => {
  it("sends section text with refs but not contact values", () => {
    const view = JSON.stringify(toAIResumeView(SAMPLE_RESUME_CONTENT));
    expect(view).toContain('"ref":"s0.e1"');
    expect(view).toContain("Built 30 operational dashboards");
    expect(view).not.toContain("sam.rivera@example.test");
    expect(view).not.toContain("555-010-4477");
    expect(view).toContain('"kind":"awards"');
  });
});

describe("finalizePlan", () => {
  it("accepts a complete plan without issues and places every item once", async () => {
    const { plan, issues, warnings } = await finalize();
    expect(issues).toEqual([]);
    // Skills, Awards and Languages have no template section.
    expect(warnings).toEqual([
      'Content the template has no section for (Skills, Awards, Languages) was added under "Additional Information" at the end.',
    ]);
    expect(placed(plan).sort()).toEqual(requiredRefs(SAMPLE_RESUME_CONTENT).sort());
    expect(plan.source).toEqual(source);
  });

  it("reports missing content and places it next to related content", async () => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      sections: { sources: string[] }[];
    };
    raw.sections[1]!.sources = ["s0.e1"]; // drops s0.e0
    raw.sections.splice(4, 1); // drops the Awards section
    const { plan, issues, warnings } = await finalize(raw);

    expect(issues).toEqual(
      expect.arrayContaining([
        'Content "s0.e0" is not placed in any section.',
        'Content "s3.e0" is not placed in any section.',
      ]),
    );
    // Nothing is lost: resume order kept within Experience; Awards (no template
    // section) joins Skills and Languages under "Additional Information", in resume order.
    expect(plan.sections[1]!.sources).toEqual(["s0.e0", "s0.e1"]);
    expect(plan.sections.at(-1)).toMatchObject({
      heading: "Additional Information",
      layout: "bullets",
      sources: ["s2.e0", "s3.e0", "s4.e0"],
    });
    expect(placed(plan).sort()).toEqual(requiredRefs(SAMPLE_RESUME_CONTENT).sort());
    expect(warnings).toEqual([
      'Some content from "Experience" was placed automatically.',
      'Some content from "Awards" was placed automatically.',
      'Content the template has no section for (Skills, Awards, Languages) was added under "Additional Information" at the end.',
    ]);
  });

  it("drops unknown and duplicate references, and rejects invented headings", async () => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      sections: { heading: string; sources: string[] }[];
    };
    raw.sections[1]!.sources = ["s0", "s9.e0", "s0.e0"];
    raw.sections[2]!.heading = "Harvard Medical Degrees";
    const { plan, issues } = await finalize(raw);

    expect(issues).toEqual(
      expect.arrayContaining([
        'Reference "s9.e0" does not exist.',
        'Content "s0.e0" is placed more than once.',
        expect.stringContaining('Heading "Harvard Medical Degrees" is not a template heading'),
      ]),
    );
    expect(plan.sections[1]!.sources).toEqual(["s0.e0", "s0.e1"]);
    expect(plan.sections[2]!.heading).toBe("EDUCATION"); // the template's heading for the kind
  });

  it("enforces the template's section order", async () => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as { sections: unknown[] };
    const [summary, experience, education, ...rest] = raw.sections;
    raw.sections = [summary, education, experience, ...rest];
    const { plan, issues } = await finalize(raw);
    expect(issues).toContain(
      "Sections that use template headings must follow the template's section order.",
    );
    // Template sections in template order; everything else last, under one heading.
    expect(plan.sections.map((section) => section.heading)).toEqual([
      "PROFESSIONAL SUMMARY",
      "EXPERIENCE",
      "EDUCATION",
      "Additional Information",
    ]);
  });

  it("applies template evidence over the AI's presentation choices", async () => {
    const { plan } = await finalize({
      ...SAMPLE_AI_PLAN,
      page: { size: "letter", columns: 2, marginsInches: { top: 2, right: 2, bottom: 2, left: 2 } },
      typography: { ...SAMPLE_AI_PLAN.typography, bodySizePt: 14, headingCase: "title" },
    });
    expect(plan.page.size).toBe("a4");
    expect(plan.page.columns).toBe(1);
    expect(plan.page.marginsInches).toEqual({ top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 });
    expect(plan.typography).toMatchObject({
      bodySizePt: 10,
      headingSizePt: 13,
      headingCase: "upper",
    });
    expect(plan.entries.datePosition).toBe("right");
  });

  it("shows every present contact field and makes page breaks safe", async () => {
    const raw = structuredClone(SAMPLE_AI_PLAN) as unknown as {
      header: { fields: string[] };
      sections: { pageBreakBefore?: boolean }[];
    };
    raw.header.fields = ["email"];
    raw.sections[0]!.pageBreakBefore = true;
    raw.sections[1]!.pageBreakBefore = true;
    raw.sections[2]!.pageBreakBefore = true;
    const { plan } = await finalize(raw);
    expect(plan.header.fields).toEqual([
      "email",
      "fullName",
      "headline",
      "phone",
      "location",
      "links",
    ]);
    expect(plan.sections.slice(0, 3).map((section) => section.pageBreakBefore)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
