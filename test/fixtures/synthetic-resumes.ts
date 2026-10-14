import type { ResumeContent, ResumeEntry } from "@/lib/documents/resume-content";

/*
 * Fictional, synthetic resumes for DOCX quality tests. No real person's data.
 * Generated deterministically so test output is stable.
 */

const COMPANIES = ["Contoso", "Fabrikam", "Northwind", "Tailspin", "Wingtip", "Litware", "Adatum"];
const ROLES = ["Analyst", "Engineer", "Consultant", "Coordinator", "Specialist", "Manager"];
const MONTHS = ["Jan", "Mar", "May", "Jul", "Sep", "Nov"];

function job(i: number, bullets: number): ResumeEntry {
  const year = 2024 - i * 2;
  return {
    heading: `Senior ${ROLES[i % ROLES.length]} ${i + 1}`,
    subheading: `${COMPANIES[i % COMPANIES.length]} Synthetic Ltd`,
    location: i % 2 === 0 ? "Denver, CO" : undefined,
    startDate: `${MONTHS[i % MONTHS.length]} ${year - 2}`,
    endDate: i === 0 ? "Present" : `${MONTHS[(i + 2) % MONTHS.length]} ${year}`,
    bullets: Array.from(
      { length: bullets },
      (_, b) =>
        `Delivered synthetic initiative ${i}.${b} that improved a test metric by ${10 + b}%`,
    ),
  };
}

const contact = {
  fullName: "Alex Example",
  headline: "Synthetic Operations Lead",
  email: "alex.example@example.test",
  phone: "555-010-0000",
  location: "Austin, TX",
  links: [
    { label: "LinkedIn", url: "https://www.linkedin.com/in/alex-example-test/" },
    { label: "GitHub", url: "https://github.com/alex-example-test" },
  ],
};

const education: ResumeContent["sections"][number] = {
  kind: "education",
  title: "Education",
  entries: [
    {
      heading: "Example State University",
      subheading: "B.Sc. Information Systems",
      endDate: "2012",
      bullets: [],
    },
  ],
};

export const SYNTHETIC_RESUMES: Record<string, ResumeContent> = {
  onePage: {
    contact,
    summary: "Operations lead with eight years of synthetic experience in reporting.",
    sections: [
      { kind: "experience", title: "Experience", entries: [job(0, 3), job(1, 2)] },
      education,
      { kind: "skills", title: "Skills", entries: [{ bullets: ["SQL", "Python", "Excel"] }] },
    ],
  },
  twoPage: {
    contact,
    summary:
      "Operations lead with twelve years of synthetic experience.\n\nKnown for building reporting teams and processes.",
    sections: [
      {
        kind: "experience",
        title: "Professional Experience",
        entries: [0, 1, 2, 3, 4].map((i) => job(i, 6)),
      },
      education,
      {
        kind: "skills",
        title: "Skills",
        entries: [{ bullets: ["SQL", "Python", "Tableau", "Power BI", "dbt"] }],
      },
    ],
  },
  longHistory: {
    contact,
    summary: "Twenty-five years of synthetic experience across many roles.",
    sections: [
      {
        kind: "experience",
        title: "Work History",
        entries: Array.from({ length: 15 }, (_, i) => job(i, 4)),
      },
      education,
    ],
  },
  manySkills: {
    contact,
    sections: [
      { kind: "experience", title: "Experience", entries: [job(0, 2)] },
      {
        kind: "skills",
        title: "Technical Skills",
        entries: [
          {
            heading: "Languages",
            bullets: ["Python", "TypeScript", "Go", "Rust", "SQL", "R", "Java", "C#"],
          },
          { bullets: Array.from({ length: 60 }, (_, i) => `Skill-${i + 1}`) },
          { bullets: ["Data modelling: star schemas, slowly changing dimensions, and data vault"] },
        ],
      },
    ],
  },
  projects: {
    contact,
    sections: [
      { kind: "experience", title: "Experience", entries: [job(0, 3)] },
      {
        kind: "projects",
        title: "Projects",
        entries: [
          {
            heading: "Synthetic Forecasting Tool",
            startDate: "2022",
            endDate: "2023",
            description: "Built a forecasting prototype for test data.",
            bullets: ["Reduced error by 12%"],
          },
          {
            heading: "Open Data Dashboard",
            description: "Public dashboard over synthetic open data.",
            bullets: [],
          },
        ],
      },
    ],
  },
  customSections: {
    contact,
    summary: "Synthetic profile with many additional sections.",
    sections: [
      { kind: "experience", title: "Experience", entries: [job(0, 2)] },
      {
        kind: "certifications",
        title: "Certifications",
        entries: [{ heading: "Certified Example Analyst", endDate: "2020", bullets: [] }],
      },
      {
        kind: "custom",
        title: "Awards",
        entries: [{ heading: "Example Award for Testing", endDate: "2021", bullets: [] }],
      },
      {
        kind: "custom",
        title: "Languages",
        entries: [{ bullets: ["English (native)", "Portuguese (B2)"] }],
      },
      {
        kind: "custom",
        title: "Publications",
        entries: [
          {
            heading: "On Synthetic Data",
            subheading: "Journal of Examples",
            endDate: "2019",
            bullets: [],
          },
        ],
      },
      {
        kind: "custom",
        title: "Volunteering",
        entries: [{ description: "Mentor at a synthetic coding club.", bullets: [] }],
      },
    ],
  },
  missingOptional: {
    contact: { fullName: "Sam Minimal", links: [] },
    sections: [
      {
        kind: "experience",
        title: "Experience",
        entries: [
          { heading: "Assistant", bullets: ["Answered synthetic support tickets"] },
          { subheading: "Untitled Org", bullets: [] },
          { startDate: "2019", bullets: ["Date-only entry"] },
        ],
      },
      {
        kind: "education",
        title: "Education",
        entries: [{ heading: "Example College", bullets: [] }],
      },
    ],
  },
};
