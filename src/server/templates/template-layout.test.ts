import { describe, expect, it } from "vitest";

import {
  makeEmptyPdf,
  makeHeadingStylesDocx,
  makeTableLayoutDocx,
  makeTemplateDocx,
  makeTemplatePdf,
  makeTwoColumnDocx,
  makeTwoColumnPdf,
} from "@test/fixtures/make-documents";

import { extractTemplateLayout } from "./template-layout";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("template layout digest (real files)", () => {
  it("reads sizes, positions, page size and right-aligned text from a PDF", async () => {
    const layout = await extractTemplateLayout(await makeTemplatePdf(), PDF);

    expect(layout.hints.pageSize).toBe("a4");
    expect(layout.hints.baseSizePt).toBe(10);
    expect(layout.hints.headingSizesPt).toEqual([20, 13]);
    expect(layout.hints.rightAlignedText).toBe(true);
    expect(layout.hints.marginsInches).toBeCloseTo(0.8, 1);
    expect(layout.digest).toContain("size=13 x=56] PROFESSIONAL SUMMARY");
    expect(layout.digest).toContain("⟶[right] [MM/YYYY] - [MM/YYYY]");
    expect(layout.text).toContain("[CANDIDATE NAME]");
  });

  it("reads headings, bullets, tables, fonts and page size from a DOCX", async () => {
    const layout = await extractTemplateLayout(await makeTemplateDocx(), DOCX);

    expect(layout.digest).toContain("[heading h1] Key Skills");
    expect(layout.digest).toContain("[bullet] [Skill 1]");
    expect(layout.digest).toContain("[table-row] [Company] | [Dates]");
    expect(layout.digest).toContain("[bold] Education");
    expect(layout.hints.fonts).toContain("Calibri");
    expect(layout.hints.baseSizePt).toBe(11);
    expect(layout.hints.hasTables).toBe(true);
    expect(layout.hints.pageSize).toBe("a4");
  });

  it("returns empty text for a PDF without a text layer", async () => {
    const layout = await extractTemplateLayout(await makeEmptyPdf(), PDF);
    expect(layout.text.trim()).toBe("");
  });

  it("rejects corrupt and unsupported inputs", async () => {
    await expect(extractTemplateLayout(new TextEncoder().encode("%PDF-x"), PDF)).rejects.toThrow();
    await expect(extractTemplateLayout(new Uint8Array([1]), "image/png")).rejects.toThrow();
  });

  it("separates a two-column PDF into columns instead of interleaving them", async () => {
    const layout = await extractTemplateLayout(await makeTwoColumnPdf(), PDF);
    expect(layout.hints.twoColumnsLikely).toBe(true);
    const lines = layout.digest.split("\n");
    expect(lines[0]).toContain("[CANDIDATE NAME]"); // full-width banner first
    const col1 = lines.indexOf("[column 1]");
    const col2 = lines.indexOf("[column 2]");
    expect(col1).toBeGreaterThan(0);
    expect(col2).toBeGreaterThan(col1);
    expect(lines.slice(col1, col2).join(" ")).toMatch(/CONTACT.*SKILLS.*LANGUAGES/);
    expect(lines.slice(col2).join(" ")).toMatch(/PROFILE.*EXPERIENCE.*EDUCATION/);
    expect(layout.digest).not.toContain("SKILLS [Role]"); // no merged columns
    expect(layout.hints.rightAlignedText).toBe(false);
  });

  it("detects two columns in DOCX templates (section columns and layout tables)", async () => {
    expect(
      (await extractTemplateLayout(await makeTwoColumnDocx(), DOCX)).hints.twoColumnsLikely,
    ).toBe(true);
    const table = await extractTemplateLayout(await makeTableLayoutDocx(), DOCX);
    expect(table.hints).toMatchObject({ twoColumnsLikely: true, hasTables: true });
    expect(table.digest).toContain("[column 1]\nCONTACT\n[Email]\nSKILLS");
    expect(table.digest).toContain("[column 2]\nEXPERIENCE");
  });

  it("marks heading styles and right-aligned dates in DOCX templates", async () => {
    const layout = await extractTemplateLayout(await makeHeadingStylesDocx(), DOCX);
    expect(layout.digest).toContain("[heading h1] Professional Profile");
    expect(layout.digest).toContain("[heading h2] Education");
    expect(layout.digest).toContain("[bold] CAREER HISTORY");
    expect(layout.digest).toContain("[underlined] Certifications");
    expect(layout.digest).toContain("[Job Title], [Company] ⟶[right] [MMM YYYY] – [MMM YYYY]");
    expect(layout.hints).toMatchObject({
      rightAlignedText: true,
      baseSizePt: 10.5,
      fonts: ["Garamond"],
    });
  });

  it("does not guess the body size from heading styles", async () => {
    // No default size in the document: unknown rather than the Title size.
    expect(
      (await extractTemplateLayout(await makeTwoColumnDocx(), DOCX)).hints.baseSizePt,
    ).toBeUndefined();
  });
});
