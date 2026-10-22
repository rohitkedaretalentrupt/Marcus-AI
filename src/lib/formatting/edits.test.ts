import { describe, expect, it } from "vitest";

import type { ResumeContent } from "@/lib/documents/resume-content";

import {
  applyEditActions,
  applyEdits,
  describeEdits,
  editableSections,
  NO_EDITS,
  parseStoredEdits,
  resolveSection,
} from "./edits";

const CONTENT: ResumeContent = {
  contact: { fullName: "Pat Example", links: [] },
  summary: "Warehouse worker with ten years of experience. Safe and reliable.",
  sections: [
    {
      kind: "experience",
      title: "Work Experience",
      entries: [
        {
          heading: "Picker",
          subheading: "Acme",
          description: "Picked orders daily. Operated a forklift safely.",
          bullets: ["Trained new staff"],
        },
      ],
    },
    {
      kind: "skills",
      title: "Skills",
      entries: [{ bullets: ["Forklift", "Inventory"] }],
    },
    {
      kind: "education",
      title: "Education",
      entries: [
        { heading: "High school diploma", description: "Graduated with honours.", bullets: [] },
      ],
    },
  ],
};

describe("section names", () => {
  it("lists the summary and every section, and finds a name case-insensitively", () => {
    expect(editableSections(CONTENT)).toEqual([
      "Summary",
      "Work Experience",
      "Skills",
      "Education",
    ]);
    expect(resolveSection(CONTENT, "  skills ")).toBe("Skills");
    expect(resolveSection(CONTENT, "Hobbies")).toBeNull();
  });
});

describe("applyEditActions", () => {
  it("adds, undoes and combines changes", () => {
    let edits = applyEditActions(NO_EDITS, [
      { action: "remove", section: "Skills" },
      { action: "bullets", section: "Education" },
    ]);
    expect(edits).toEqual({ removeSections: ["Skills"], bulletSections: ["Education"] });

    edits = applyEditActions(edits, [{ action: "restore", section: "skills" }]);
    expect(edits.removeSections).toEqual([]);

    edits = applyEditActions(edits, [{ action: "paragraph", section: "EDUCATION" }]);
    expect(edits.bulletSections).toEqual([]);

    // Removing a section drops its bullets; asking twice changes nothing more.
    edits = applyEditActions(NO_EDITS, [
      { action: "bullets", section: "Education" },
      { action: "remove", section: "Education" },
      { action: "remove", section: "Education" },
    ]);
    expect(edits).toEqual({ removeSections: ["Education"], bulletSections: [] });
  });
});

describe("applyEdits", () => {
  it("leaves everything alone without edits", () => {
    const edited = applyEdits(CONTENT, NO_EDITS);
    expect(edited.content).toEqual(CONTENT);
    expect(edited.bulletSections).toEqual([]);
    expect(edited.bulletSummary).toBe(false);
  });

  it("removes sections and the summary", () => {
    const { content } = applyEdits(CONTENT, {
      removeSections: ["skills", "Summary"],
      bulletSections: [],
    });
    expect(content.sections.map((section) => section.title)).toEqual([
      "Work Experience",
      "Education",
    ]);
    expect(content.summary).toBeUndefined();
    expect(content.contact.fullName).toBe("Pat Example");
  });

  it("turns a section's paragraphs into one bullet per sentence, keeping its bullets", () => {
    const edited = applyEdits(CONTENT, {
      removeSections: ["Skills"],
      bulletSections: ["Work Experience", "Summary"],
    });
    const [experience] = edited.content.sections;
    expect(experience!.entries[0]!.description).toBeUndefined();
    expect(experience!.entries[0]!.bullets).toEqual([
      "Picked orders daily.",
      "Operated a forklift safely.",
      "Trained new staff",
    ]);
    // The index is in the edited content (Skills is gone, so Education is index 1).
    expect(edited.bulletSections).toEqual([0]);
    expect(edited.bulletSummary).toBe(true);
    // The input is not changed.
    expect(CONTENT.sections[0]!.entries[0]!.description).toBe(
      "Picked orders daily. Operated a forklift safely.",
    );
  });
});

describe("describing and storing edits", () => {
  it("describes them for a job card, and reads stored values safely", () => {
    expect(describeEdits({ removeSections: ["Skills"], bulletSections: ["Education"] })).toEqual([
      "Without Skills",
      "Education as bullets",
    ]);
    expect(describeEdits(null)).toEqual([]);
    expect(parseStoredEdits({ removeSections: ["Skills"] })).toEqual({
      removeSections: ["Skills"],
      bulletSections: [],
    });
    expect(parseStoredEdits("garbage")).toEqual(NO_EDITS);
    expect(parseStoredEdits(null)).toEqual(NO_EDITS);
  });
});
