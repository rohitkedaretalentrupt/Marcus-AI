import { describe, expect, it } from "vitest";

import { SAMPLE_TEMPLATE_STRUCTURE } from "@test/fixtures/template-structure";

import { clientTemplateStructureSchema } from "./structure";

describe("clientTemplateStructureSchema", () => {
  it("accepts a valid analysis and fills defaults", () => {
    const parsed = clientTemplateStructureSchema.parse(SAMPLE_TEMPLATE_STRUCTURE);
    expect(parsed.sections[2]).toEqual({
      kind: "education",
      heading: "EDUCATION",
      contentHints: [],
    });
  });

  it("defaults unknown layout/typography facts instead of guessing", () => {
    const parsed = clientTemplateStructureSchema.parse({
      version: 1,
      summary: "Minimal",
      sections: [{ kind: "skills", heading: "Skills" }],
      header: {},
      layout: {},
      typography: {},
    });
    expect(parsed.layout).toEqual({
      columns: 1,
      pageSize: "unknown",
      margins: "unknown",
      dateAlignment: "unknown",
    });
    expect(parsed.typography.headingCase).toBe("unknown");
    expect(parsed.header).toEqual({ fields: [], alignment: "unknown" });
  });

  it.each([
    ["an unknown section kind", { sections: [{ kind: "hobbies", heading: "Hobbies" }] }],
    ["no sections", { sections: [] }],
    ["three columns", { layout: { columns: 3 } }],
    ["an absurd font size", { typography: { baseSizePt: 99 } }],
    ["a wrong version", { version: 2 }],
    ["an unknown header field", { header: { fields: ["ssn"] } }],
  ])("rejects %s", (_name, override) => {
    expect(
      clientTemplateStructureSchema.safeParse({ ...SAMPLE_TEMPLATE_STRUCTURE, ...override })
        .success,
    ).toBe(false);
  });
});
