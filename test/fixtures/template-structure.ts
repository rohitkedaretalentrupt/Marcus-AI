/** A valid (test-only) AI template analysis result. */
export const SAMPLE_TEMPLATE_STRUCTURE = {
  version: 1,
  summary: "Single-column A4 template with uppercase headings and right-aligned dates.",
  sections: [
    { kind: "summary", heading: "PROFESSIONAL SUMMARY", contentHints: ["3-4 line paragraph"] },
    { kind: "experience", heading: "EXPERIENCE", contentHints: ["dates right-aligned", "bullets"] },
    { kind: "education", heading: "EDUCATION" },
  ],
  header: {
    fields: ["fullName", "headline", "email", "phone", "location", "links"],
    alignment: "left",
  },
  layout: { columns: 1, pageSize: "a4", margins: "normal", dateAlignment: "right" },
  typography: { headingCase: "upper", baseSizePt: 10, headingSizePt: 13 },
  placeholders: [{ text: "[CANDIDATE NAME]", meaning: "Candidate's full name" }],
  notes: [],
} as const;
