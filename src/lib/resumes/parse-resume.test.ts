import { describe, expect, it } from "vitest";

import { resumeContentSchema } from "@/lib/documents/resume-content";

import { NoExtractableTextError, normalizeResumeText, parseResumeText } from "./parse-resume";

// Fictional, test-only resume text.
const STANDARD = `
Jane Q. Doe
Senior Product Designer
jane.doe@example.test | +1 (555) 010-2030 | Austin, TX | linkedin.com/in/janedoe-test

Professional Summary
Product designer with 8 years of experience shipping B2B SaaS products.
Focused on design systems and accessibility.

Work Experience
Lead Designer
Acme Corp — Austin, TX
Jan 2021 – Present
• Led a team of 5 designers across 3 product lines
• Built the company design system used by 40 engineers

Product Designer                                    Mar 2017 - Dec 2020
Globex
- Redesigned onboarding, improving activation by 18%

Education
University of Texas at Austin
B.S. Human-Computer Interaction, 2016

Skills
Figma, Sketch, Prototyping; User Research
Languages: English, Spanish

Certifications
Certified Usability Analyst (CUA) 2019
`;

describe("parseResumeText", () => {
  it("extracts contact details, summary and sections from a typical resume", () => {
    const { content, warnings } = parseResumeText(STANDARD);

    expect(content.contact).toMatchObject({
      fullName: "Jane Q. Doe",
      headline: "Senior Product Designer",
      email: "jane.doe@example.test",
      phone: "+1 (555) 010-2030",
      location: "Austin, TX",
    });
    expect(content.contact.links).toEqual([
      { label: "LinkedIn", url: "https://linkedin.com/in/janedoe-test" },
    ]);
    expect(content.summary).toBe(
      "Product designer with 8 years of experience shipping B2B SaaS products. Focused on design systems and accessibility.",
    );
    expect(content.sections.map((s) => [s.kind, s.title])).toEqual([
      ["experience", "Work Experience"],
      ["education", "Education"],
      ["skills", "Skills"],
      ["certifications", "Certifications"],
    ]);
    expect(warnings).toEqual([]);
  });

  it("splits experience into entries with headings, employers, dates and bullets", () => {
    const experience = parseResumeText(STANDARD).content.sections[0]!;
    expect(experience.entries).toEqual([
      {
        heading: "Lead Designer",
        subheading: "Acme Corp — Austin, TX",
        startDate: "Jan 2021",
        endDate: "Present",
        bullets: [
          "Led a team of 5 designers across 3 product lines",
          "Built the company design system used by 40 engineers",
        ],
      },
      {
        heading: "Product Designer",
        subheading: "Globex",
        startDate: "Mar 2017",
        endDate: "Dec 2020",
        bullets: ["Redesigned onboarding, improving activation by 18%"],
      },
    ]);
  });

  it("reads a line that is only a year as the entry's date, not as its description", () => {
    const text = [
      "Rico Synthetic",
      "",
      "Professional Experience",
      "Forklift operator",
      "Example Bakeries, Avon Indiana",
      "2021",
      "Inspected forklifts daily. Logged load weights each shift.",
    ].join("\n");
    expect(parseResumeText(text).content.sections[0]!.entries).toEqual([
      {
        heading: "Forklift operator",
        subheading: "Example Bakeries, Avon Indiana",
        endDate: "2021",
        description: "Inspected forklifts daily. Logged load weights each shift.",
        bullets: [],
      },
    ]);
  });

  it("parses education years and skill lists (keeping categorised lines whole)", () => {
    const { sections } = parseResumeText(STANDARD).content;
    expect(sections[1]!.entries[0]).toMatchObject({
      heading: "University of Texas at Austin",
      subheading: "B.S. Human-Computer Interaction",
      endDate: "2016",
    });
    expect(sections[2]!.entries[0]!.bullets).toEqual([
      "Figma",
      "Sketch",
      "Prototyping",
      "User Research",
      "Languages: English, Spanish",
    ]);
  });

  it("keeps a sentence under a skills heading whole instead of cutting it at commas", () => {
    const text = `Pat Example
pat@example.test

Skills
Roadmapping, Stakeholder Management
Led post-merger consolidation across Canada, the U.S., and Mexico.
Built a repeatable release framework with readiness gates, SIT/UAT, and cutover planning.
`;
    const skills = parseResumeText(text).content.sections.find((s) => s.title === "Skills")!;
    expect(skills.entries[0]!.bullets).toEqual([
      "Roadmapping",
      "Stakeholder Management",
      "Led post-merger consolidation across Canada, the U.S., and Mexico.",
      "Built a repeatable release framework with readiness gates, SIT/UAT, and cutover planning.",
    ]);
  });

  it("splits a skills list separated by two-space gaps across wrapped lines, keeping wrapped items whole", () => {
    const text = [
      "Pat Example",
      "pat@example.test",
      "Skills",
      "Stand-up forklift operation  Safe work practices  Computer operation  Order",
      "Picker  Microsoft Word  Shipping &",
      "Receiving  Warehouse safety compliance  Forklift  - Forklift experience (6–10 years)",
    ].join("\n");
    const skills = parseResumeText(text).content.sections.find((s) => s.title === "Skills")!;
    expect(skills.entries[0]!.bullets).toEqual([
      "Stand-up forklift operation",
      "Safe work practices",
      "Computer operation",
      "Order Picker",
      "Microsoft Word",
      "Shipping & Receiving",
      "Warehouse safety compliance",
      "Forklift",
      "Forklift experience (6–10 years)",
    ]);
  });

  it("reads languages, interests and additional information as lists, and certifications one per line", () => {
    const text = [
      "Pat Example",
      "pat@example.test",
      "Languages",
      "English - Intermediate",
      "Spanish",
      "Certifications and Licenses",
      "Forklift Certification",
      "Pallet Jack Certification",
      "Driver's License",
      "Additional Information",
      "Authorized to work in the US for any employer",
    ].join("\n");
    const sections = parseResumeText(text).content.sections;
    expect(sections.find((s) => s.title === "Languages")!.entries).toEqual([
      { bullets: ["English - Intermediate", "Spanish"] },
    ]);
    expect(
      sections
        .find((s) => s.title === "Certifications and Licenses")!
        .entries.map((e) => e.heading),
    ).toEqual(["Forklift Certification", "Pallet Jack Certification", "Driver's License"]);
    expect(sections.find((s) => s.title === "Additional Information")!.entries).toEqual([
      { bullets: ["Authorized to work in the US for any employer"] },
    ]);
  });

  it("recognises ALL-CAPS headings and unknown custom sections", () => {
    const { content } = parseResumeText(`
JOHN SMITH
john@example.test
EXPERIENCE
Engineer, Initech 2015 - 2019
• Maintained TPS report pipelines and reporting
VOLUNTEER WORK
Food bank driver
PUBLICATIONS
Paper on reliable systems 2018
`);
    expect(content.contact.fullName).toBe("JOHN SMITH");
    expect(content.sections.map((s) => [s.kind, s.title])).toEqual([
      ["experience", "Experience"],
      ["custom", "Volunteer Work"],
      ["custom", "Publications"],
    ]);
    expect(content.sections[0]!.entries[0]).toMatchObject({
      heading: "Engineer, Initech",
      startDate: "2015",
      endDate: "2019",
    });
  });

  it("always produces schema-valid content and reports what it could not find", () => {
    const { content, warnings } = parseResumeText(
      "Some notes about a career in logistics and operations management across several regions and companies over many years.",
    );
    expect(resumeContentSchema.safeParse(content).success).toBe(true);
    expect(content.contact.fullName).toBe("Unnamed candidate");
    expect(warnings).toEqual(
      expect.arrayContaining([
        "Couldn't detect the candidate's name.",
        "Couldn't find an email address.",
        "Couldn't find standard sections such as Experience, Education or Skills.",
      ]),
    );
  });

  it("clamps oversized input to the schema limits instead of failing", () => {
    const bullets = Array.from({ length: 80 }, (_, i) => `• Achievement number ${i}`).join("\n");
    const { content, warnings } = parseResumeText(
      `Alex Example\nalex@example.test\nExperience\nEngineer\n${bullets}\n`,
    );
    expect(content.sections[0]!.entries[0]!.bullets).toHaveLength(50);
    expect(warnings).toContain("Some bullet points were not included.");
  });

  it("rejects documents without extractable text (e.g. scanned images)", () => {
    expect(() => parseResumeText("   \n\n  1  \n")).toThrow(NoExtractableTextError);
  });

  it("does not treat injected markup as anything but text", () => {
    const { content } = parseResumeText(
      `Mallory Test\nmallory@example.test\nSkills\n<script>alert(1)</script>, SQL\n`,
    );
    expect(content.sections[0]!.entries[0]!.bullets).toEqual(["<script>alert(1)</script>", "SQL"]);
  });
});

describe("normalizeResumeText", () => {
  it("normalises line endings, odd spaces and repeated blank lines", () => {
    expect(normalizeResumeText("A\r\n\r\n\r\nB  C​")).toEqual(["A", "", "B C"]);
  });
});
