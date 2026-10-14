import { describe, expect, it } from "vitest";

import { parseResumeText } from "@/lib/resumes/parse-resume";
import {
  makeDocx,
  makeEmptyPdf,
  makePdf,
  SAMPLE_RESUME_LINES,
} from "@test/fixtures/make-documents";

import { docxTextExtractor, extractorFor, pdfTextExtractor } from "./extractors";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("document text extractors (real files)", () => {
  it("extracts line-structured text from a PDF and parses it", async () => {
    const extracted = await pdfTextExtractor.extract(await makePdf(SAMPLE_RESUME_LINES), PDF);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain("Senior Data Analyst");

    const { content } = parseResumeText(extracted.text);
    expect(content.contact).toMatchObject({
      fullName: "Sam Rivera",
      email: "sam.rivera@example.test",
    });
    expect(content.sections.map((s) => s.kind)).toEqual(["experience", "education", "skills"]);
    expect(content.sections[0]!.entries[0]).toMatchObject({
      heading: "Senior Data Analyst",
      subheading: "Contoso Health",
      startDate: "Feb 2021",
      endDate: "Present",
    });
  });

  it("extracts paragraph text from a DOCX and parses it", async () => {
    const extracted = await docxTextExtractor.extract(await makeDocx(SAMPLE_RESUME_LINES), DOCX);
    const { content } = parseResumeText(extracted.text);
    expect(content.contact.fullName).toBe("Sam Rivera");
    expect(content.summary).toBe("Analyst with 5 years of experience in healthcare reporting.");
    expect(content.sections.find((s) => s.kind === "skills")?.entries[0]?.bullets).toEqual([
      "SQL",
      "Python",
      "Tableau",
    ]);
  });

  it("returns no text for a PDF without a text layer (scan)", async () => {
    const extracted = await pdfTextExtractor.extract(await makeEmptyPdf(), PDF);
    expect(extracted.text.trim()).toBe("");
  });

  it("fails on corrupt input instead of returning garbage", async () => {
    const junk = new TextEncoder().encode("%PDF-1.7 not really a pdf");
    await expect(pdfTextExtractor.extract(junk, PDF)).rejects.toThrow();
    const zipNotDocx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(docxTextExtractor.extract(zipNotDocx, DOCX)).rejects.toThrow();
  });

  it("has extractors only for PDF and DOCX (no OCR for images)", () => {
    expect(extractorFor(PDF)).toBe(pdfTextExtractor);
    expect(extractorFor(DOCX)).toBe(docxTextExtractor);
    expect(extractorFor("image/png")).toBeNull();
  });
});
