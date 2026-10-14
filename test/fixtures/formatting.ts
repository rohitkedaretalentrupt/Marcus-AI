import type { ResumeContent } from "@/lib/documents/resume-content";
import type { AIFormattingPlan } from "@/lib/formatting/plan";

/** Fictional, synthetic resume content (test-only). */
export const SAMPLE_RESUME_CONTENT: ResumeContent = {
  contact: {
    fullName: "Sam Rivera",
    headline: "Data Analyst",
    email: "sam.rivera@example.test",
    phone: "555-010-4477",
    location: "Denver, CO",
    links: [
      { label: "LinkedIn", url: "https://www.linkedin.com/in/sam-rivera-test/" },
      { label: "Website", url: "https://sam-rivera.example.test/" },
    ],
  },
  summary: "Analyst with 5 years of experience in healthcare reporting & dashboards.",
  sections: [
    {
      kind: "experience",
      title: "Experience",
      entries: [
        {
          heading: "Senior Data Analyst",
          subheading: "Contoso Health",
          location: "Denver, CO",
          startDate: "Feb 2021",
          endDate: "Present",
          bullets: ["Built 30 operational dashboards", "Reduced report time by 40%"],
        },
        {
          heading: "Data Analyst",
          subheading: "Fabrikam Clinics",
          startDate: "Jun 2018",
          endDate: "Jan 2021",
          description: "Owned weekly KPI reporting <for> 12 clinics.",
          bullets: [],
        },
      ],
    },
    {
      kind: "education",
      title: "Education",
      entries: [
        {
          heading: "University of Colorado",
          subheading: "B.S. Statistics",
          endDate: "2018",
          bullets: [],
        },
      ],
    },
    {
      kind: "skills",
      title: "Skills",
      entries: [{ bullets: ["SQL", "Python", "Tableau", "Power BI"] }],
    },
    {
      kind: "custom",
      title: "Awards",
      entries: [{ heading: "Analyst of the Year", endDate: "2022", bullets: [] }],
    },
    {
      kind: "custom",
      title: "Languages",
      entries: [{ bullets: ["English (native)", "Spanish (fluent)"] }],
    },
  ],
};

/** A valid AI plan for SAMPLE_RESUME_CONTENT + SAMPLE_TEMPLATE_STRUCTURE (raw, pre-parse). */
export const SAMPLE_AI_PLAN = {
  version: 1,
  header: {
    fields: ["fullName", "headline", "email", "phone", "location", "links"],
    alignment: "left",
  },
  sections: [
    { heading: "PROFESSIONAL SUMMARY", kind: "summary", layout: "paragraph", sources: ["summary"] },
    { heading: "EXPERIENCE", kind: "experience", layout: "entries", sources: ["s0"] },
    { heading: "EDUCATION", kind: "education", layout: "entries", sources: ["s1.e0"] },
    { heading: "Skills", kind: "skills", layout: "inline", sources: ["s2"] },
    { heading: "Awards", kind: "awards", layout: "entries", sources: ["s3"] },
    { heading: "Languages", kind: "languages", layout: "inline", sources: ["s4"] },
  ],
  typography: { bodyFont: "Arial", headingFont: "Georgia", headingColor: "#1F3864" },
  dividers: { underHeadings: true },
  footer: { pageNumbers: true },
  notes: ["Awards and Languages have no template section, so they follow Education."],
} as const;

export const parsePlan = async (raw: unknown = SAMPLE_AI_PLAN): Promise<AIFormattingPlan> => {
  const { aiFormattingPlanSchema } = await import("@/lib/formatting/plan");
  return aiFormattingPlanSchema.parse(raw);
};
