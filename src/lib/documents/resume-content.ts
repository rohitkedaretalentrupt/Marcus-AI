import { z } from "zod";

/**
 * Canonical, renderer-agnostic representation of a resume.
 *
 * This is the contract between the pipeline stages: extraction/AI produce it,
 * templates style it, and DOCX/PDF renderers consume it. AI output MUST be
 * validated against this schema before it is stored or rendered.
 */

export const RESUME_SECTION_KINDS = [
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "custom",
] as const;

export type ResumeSectionKind = (typeof RESUME_SECTION_KINDS)[number];

const shortText = z.string().trim().max(300);
const longText = z.string().trim().max(5000);

export const resumeEntrySchema = z.object({
  heading: shortText.optional(),
  subheading: shortText.optional(),
  location: shortText.optional(),
  /** Free-form as written in the source resume (e.g. "Jan 2021", "2019"). */
  startDate: shortText.optional(),
  endDate: shortText.optional(),
  description: longText.optional(),
  bullets: z.array(z.string().trim().max(1000)).max(50).default([]),
});

export const resumeSectionSchema = z.object({
  kind: z.enum(RESUME_SECTION_KINDS),
  title: shortText.min(1),
  entries: z.array(resumeEntrySchema).max(100),
});

export const resumeContentSchema = z.object({
  contact: z.object({
    fullName: shortText.min(1),
    headline: shortText.optional(),
    email: z.email().optional(),
    phone: shortText.optional(),
    location: shortText.optional(),
    links: z
      .array(z.object({ label: shortText, url: z.url() }))
      .max(10)
      .default([]),
  }),
  summary: longText.optional(),
  sections: z.array(resumeSectionSchema).max(30),
});

export type ResumeEntry = z.infer<typeof resumeEntrySchema>;
export type ResumeSection = z.infer<typeof resumeSectionSchema>;
export type ResumeContent = z.infer<typeof resumeContentSchema>;
