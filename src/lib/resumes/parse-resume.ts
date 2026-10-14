import {
  resumeContentSchema,
  type ResumeContent,
  type ResumeEntry,
  type ResumeSectionKind,
} from "@/lib/documents/resume-content";

/**
 * Deterministic resume parser: plain text → ResumeContent. No AI. It
 * recognises common section headings, contact details, bullets and date
 * ranges; anything it cannot place is kept as description text rather than
 * dropped, and what it could not detect is reported as warnings.
 *
 * Bump PARSER_VERSION whenever the rules change so stored results can be
 * re-generated.
 */
export const PARSER_VERSION = 2;

/** Below this many letters/digits the document is treated as having no text (e.g. a scan). */
const MIN_TEXT_CHARS = 40;

const LIMITS = {
  short: 300,
  long: 5000,
  bullet: 1000,
  bullets: 50,
  entries: 100,
  sections: 30,
  links: 10,
} as const;

export class NoExtractableTextError extends Error {
  constructor() {
    super("Document contains no extractable text");
    this.name = "NoExtractableTextError";
  }
}

export interface ParsedResume {
  content: ResumeContent;
  warnings: string[];
}

// --- headings -------------------------------------------------------------

type HeadingTarget = { kind: ResumeSectionKind | "summary" };

const HEADING_DICTIONARY: Record<string, HeadingTarget["kind"]> = {};
function register(kind: HeadingTarget["kind"], names: string[]) {
  for (const name of names) HEADING_DICTIONARY[name] = kind;
}
register("summary", [
  "summary",
  "professional summary",
  "career summary",
  "executive summary",
  "profile",
  "professional profile",
  "personal profile",
  "about me",
  "about",
  "objective",
  "career objective",
  "personal statement",
  "overview",
]);
register("experience", [
  "experience",
  "work experience",
  "professional experience",
  "relevant experience",
  "employment",
  "employment history",
  "work history",
  "career history",
  "professional background",
]);
register("education", [
  "education",
  "education and training",
  "education & training",
  "academic background",
  "academic qualifications",
  "qualifications",
  "academic history",
]);
register("skills", [
  "skills",
  "technical skills",
  "key skills",
  "core skills",
  "core competencies",
  "competencies",
  "areas of expertise",
  "expertise",
  "skills and abilities",
  "skills & abilities",
  "skill set",
  "technologies",
  "tools and technologies",
  "tools & technologies",
]);
register("projects", ["projects", "key projects", "personal projects", "selected projects"]);
register("certifications", [
  "certifications",
  "certification",
  "certificates",
  "licenses",
  "licences",
  "licenses and certifications",
  "licenses & certifications",
  "certifications and licenses",
  "certifications & licenses",
  "accreditations",
]);
register("custom", [
  "languages",
  "awards",
  "honors",
  "honours",
  "awards and honors",
  "awards & honors",
  "publications",
  "volunteer",
  "volunteering",
  "volunteer experience",
  "interests",
  "hobbies",
  "hobbies and interests",
  "references",
  "activities",
  "leadership",
  "achievements",
  "courses",
  "training",
  "additional information",
]);

function headingKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/[:.]+$/, "")
    .replace(/[^a-z& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text.replace(/[:]+$/, "").trim();
  return text
    .toLowerCase()
    .replace(/[:]+$/, "")
    .replace(/\b([a-z])/g, (char) => char.toUpperCase())
    .replace(/\b(And|Of|The)\b/g, (word) => word.toLowerCase())
    .trim();
}

function matchHeading(line: string, allowGeneric: boolean): HeadingTarget | null {
  if (line.length > 50 || line.split(" ").length > 6) return null;
  const kind = HEADING_DICTIONARY[headingKey(line)];
  if (kind) return { kind };
  // Unknown ALL-CAPS short line after the first real section: a custom heading.
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (
    allowGeneric &&
    letters.length >= 3 &&
    line === line.toUpperCase() &&
    !/[\d@]/.test(line) &&
    line.split(" ").length <= 4
  ) {
    return { kind: "custom" };
  }
  return null;
}

// --- dates, bullets, contact ------------------------------------------------

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const DATE = String.raw`(?:${MONTH}\s+\d{4}|\d{1,2}[/.]\d{4}|\d{4})`;
const DATE_RANGE = new RegExp(
  String.raw`(${DATE})\s*(?:-|–|—|to|until)\s*(${DATE}|present|current|now|today|ongoing)`,
  "i",
);
const SINGLE_DATE = new RegExp(
  String.raw`(?:^|[\s(|,–-])(${MONTH}\s+\d{4}|(?:19|20)\d{2})\s*\)?$`,
  "i",
);

const BULLET = /^(?:[•●▪◦‣∙·*•▪●–—-]|\d{1,2}[.)])\s*/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const URL_LIKE =
  /\b(?:https?:\/\/[^\s|,;]+|(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com)\/[^\s|,;]+)/gi;
const SEPARATORS = /\s*[|•·◆♦]\s*|\s{3,}/;

interface DateSplit {
  text: string;
  startDate?: string;
  endDate?: string;
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s|,;:–—-]+|[\s|,;:–—-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitDates(line: string): DateSplit {
  const range = DATE_RANGE.exec(line);
  if (range) {
    return {
      text: tidy(line.replace(range[0], " ")),
      startDate: range[1],
      endDate: range[2]!.replace(/^./, (c) => c.toUpperCase()),
    };
  }
  const single = SINGLE_DATE.exec(line);
  if (single && line.length < 120) {
    // Everything before the date (nothing when the line is only a date, e.g. "2021").
    const dateStart = single.index + single[0].indexOf(single[1]!);
    return { text: tidy(line.slice(0, dateStart)), endDate: single[1] };
  }
  return { text: line };
}

function phoneIn(text: string): string | undefined {
  const match = PHONE.exec(text)?.[0];
  if (!match) return undefined;
  const digits = match.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15 ? match.trim() : undefined;
}

function toLink(raw: string): { label: string; url: string } | null {
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(href.replace(/[).,]+$/, ""));
    const host = url.hostname.replace(/^www\./, "");
    const label = host.includes("linkedin")
      ? "LinkedIn"
      : host.includes("github")
        ? "GitHub"
        : host.includes("gitlab")
          ? "GitLab"
          : "Website";
    return { label, url: url.toString() };
  } catch {
    return null;
  }
}

function clamp(text: string, max: number, warnings: Set<string>): string {
  if (text.length <= max) return text;
  warnings.add("Some long text was shortened.");
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// --- normalisation ------------------------------------------------------------

export function normalizeResumeText(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t]/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, (spaces) => (spaces.length >= 3 ? "   " : " ")).trim())
    .reduce<string[]>((lines, line) => {
      // Collapse runs of blank lines into one.
      if (line === "" && (lines.length === 0 || lines.at(-1) === "")) return lines;
      lines.push(line);
      return lines;
    }, []);
}

// --- section bodies -------------------------------------------------------------

function isHeaderish(text: string): boolean {
  return text.length <= 100 && text.split(" ").length <= 14 && !/[.;!?]$/.test(text);
}

function parseEntries(lines: string[]): ResumeEntry[] {
  const entries: ResumeEntry[] = [];
  const hasBody = (entry: ResumeEntry) => entry.bullets.length > 0 || Boolean(entry.description);
  const start = (fields: Partial<ResumeEntry>) => {
    const entry: ResumeEntry = { bullets: [], ...fields };
    entries.push(entry);
    return entry;
  };

  for (const line of lines) {
    if (!line) continue;
    const entry: ResumeEntry | undefined = entries.at(-1);

    if (BULLET.test(line) && line.replace(BULLET, "").length > 0) {
      (entry ?? start({})).bullets.push(line.replace(BULLET, "").trim());
      continue;
    }

    const { text, startDate, endDate } = splitDates(line);
    const dates = startDate || endDate ? { startDate, endDate } : {};

    if (!text) {
      // A line that is only a date range belongs to the current entry.
      if (entry && !entry.startDate && !entry.endDate) Object.assign(entry, dates);
      else start(dates);
      continue;
    }

    if (isHeaderish(text) && (!entry || hasBody(entry))) {
      start({ heading: text, ...dates });
    } else if (isHeaderish(text) && entry && !entry.subheading && entry.heading) {
      entry.subheading = text;
      if (!entry.startDate && !entry.endDate) Object.assign(entry, dates);
    } else if (entry) {
      entry.description = entry.description ? `${entry.description} ${line}` : line;
    } else {
      start({ description: line });
    }
  }
  return entries;
}

function parseSkills(lines: string[]): ResumeEntry[] {
  const items: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(BULLET, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon > 0 && colon <= 30) {
      items.push(line); // "Languages: Python, Go" stays one categorised item
      continue;
    }
    for (const item of line.split(/\s*[,;•|·]\s*/)) if (item.trim()) items.push(item.trim());
  }
  const unique = [...new Set(items)];
  return unique.length ? [{ bullets: unique }] : [];
}

function paragraph(lines: string[]): string {
  return lines
    .map((line) => line.replace(BULLET, "").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .replace(/([^\n])\n(?!\n)/g, "$1 ")
    .trim();
}

// --- main ----------------------------------------------------------------------------

interface RawSection {
  kind: HeadingTarget["kind"];
  title: string;
  lines: string[];
}

export function parseResumeText(rawText: string): ParsedResume {
  const lines = normalizeResumeText(rawText);
  if (lines.join("").replace(/[^\p{L}\p{N}]/gu, "").length < MIN_TEXT_CHARS) {
    throw new NoExtractableTextError();
  }

  const warnings = new Set<string>();
  const header: string[] = [];
  const sections: RawSection[] = [];

  for (const line of lines) {
    const heading = line ? matchHeading(line, sections.length > 0) : null;
    if (heading) {
      sections.push({ kind: heading.kind, title: titleCase(line), lines: [] });
    } else if (sections.length > 0) {
      sections.at(-1)!.lines.push(line);
    } else {
      header.push(line);
    }
  }

  // Contact details from the header block (and the whole text as a fallback).
  const headerText = header.join("\n");
  const allText = lines.join("\n");
  const email = (EMAIL.exec(headerText) ?? EMAIL.exec(allText))?.[0];
  const phone = phoneIn(headerText);
  const links = [
    ...new Map(
      [...(headerText.match(URL_LIKE) ?? [])]
        .map(toLink)
        .filter((link): link is { label: string; url: string } => link !== null)
        .map((link) => [link.url, link]),
    ).values(),
  ].slice(0, LIMITS.links);

  const contactTokens = [email, phone, ...(headerText.match(URL_LIKE) ?? [])].filter(Boolean);
  const plainHeaderLines = header
    .filter(Boolean)
    .map((line) =>
      tidy(contactTokens.reduce<string>((text, token) => text.replace(token!, " "), line)),
    )
    .filter(Boolean);

  let location: string | undefined;
  const nameAndHeadline: string[] = [];
  const leftover: string[] = [];
  for (const line of plainHeaderLines) {
    const segments = line.split(SEPARATORS).map(tidy).filter(Boolean);
    for (const segment of segments) {
      if (!location && /^[\p{L} .'-]+,\s*[\p{L} .]{2,}$/u.test(segment) && segment.length <= 60) {
        location = segment;
      } else if (nameAndHeadline.length < 2 && segment.length <= 120 && isHeaderish(segment)) {
        nameAndHeadline.push(segment);
      } else {
        leftover.push(segment);
      }
    }
  }

  const nameCandidate = nameAndHeadline[0];
  const looksLikeName =
    nameCandidate !== undefined &&
    /^[\p{L}][\p{L} .'’-]{1,58}$/u.test(nameCandidate) &&
    nameCandidate.split(" ").length <= 5;
  if (!looksLikeName) warnings.add("Couldn't detect the candidate's name.");
  if (!email) warnings.add("Couldn't find an email address.");

  let summary: string | undefined;
  const builtSections: ResumeContent["sections"] = [];
  for (const section of sections) {
    if (section.kind === "summary") {
      const text = paragraph(section.lines);
      if (text) summary = summary ? `${summary}\n\n${text}` : text;
      continue;
    }
    const entries =
      section.kind === "skills" ? parseSkills(section.lines) : parseEntries(section.lines);
    if (entries.length === 0) continue;
    builtSections.push({ kind: section.kind, title: section.title, entries });
  }
  if (!summary && leftover.join(" ").split(" ").length >= 12) summary = leftover.join(" ");
  if (builtSections.length === 0) {
    warnings.add("Couldn't find standard sections such as Experience, Education or Skills.");
  }

  // Clamp to the schema's limits (recording a warning) so validation can pass.
  if (builtSections.length > LIMITS.sections) warnings.add("Some sections were not included.");
  const sectionsOut = builtSections.slice(0, LIMITS.sections).map((section) => {
    if (section.entries.length > LIMITS.entries) warnings.add("Some entries were not included.");
    return {
      kind: section.kind,
      title: clamp(section.title, LIMITS.short, warnings),
      entries: section.entries.slice(0, LIMITS.entries).map((entry) => {
        if (entry.bullets.length > LIMITS.bullets)
          warnings.add("Some bullet points were not included.");
        return {
          ...(entry.heading ? { heading: clamp(entry.heading, LIMITS.short, warnings) } : {}),
          ...(entry.subheading
            ? { subheading: clamp(entry.subheading, LIMITS.short, warnings) }
            : {}),
          ...(entry.startDate ? { startDate: clamp(entry.startDate, LIMITS.short, warnings) } : {}),
          ...(entry.endDate ? { endDate: clamp(entry.endDate, LIMITS.short, warnings) } : {}),
          ...(entry.description
            ? { description: clamp(entry.description, LIMITS.long, warnings) }
            : {}),
          bullets: entry.bullets
            .slice(0, LIMITS.bullets)
            .map((bullet) => clamp(bullet, LIMITS.bullet, warnings)),
        };
      }),
    };
  });

  const content = resumeContentSchema.parse({
    contact: {
      fullName: looksLikeName ? clamp(nameCandidate!, LIMITS.short, warnings) : "Unnamed candidate",
      ...(looksLikeName && nameAndHeadline[1]
        ? { headline: clamp(nameAndHeadline[1], LIMITS.short, warnings) }
        : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone: clamp(phone, LIMITS.short, warnings) } : {}),
      ...(location ? { location } : {}),
      links,
    },
    ...(summary ? { summary: clamp(summary, LIMITS.long, warnings) } : {}),
    sections: sectionsOut,
  });

  return { content, warnings: [...warnings] };
}
