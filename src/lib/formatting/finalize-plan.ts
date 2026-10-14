import type { ResumeContent } from "@/lib/documents/resume-content";
import type { ClientTemplateStructure, TemplateSection } from "@/lib/templates/structure";

import {
  entryRef,
  planKindForSection,
  presentContactFields,
  requiredRefs,
  resolveEntryRef,
} from "./content-refs";
import {
  BULLET_SYMBOLS,
  type AIFormattingPlan,
  type FormattingPlan,
  type PlanSection,
  type PlanSectionKind,
  type SectionLayout,
} from "./plan";

/**
 * Deterministic checks and fixes applied to a validated AI plan:
 *
 * 1. references: unknown ones are dropped, whole-section references are
 *    expanded to entries, duplicates are removed;
 * 2. headings: must come from the template, the resume, or a short list of
 *    neutral labels (the AI cannot introduce new wording);
 * 3. completeness: every summary/entry must be placed exactly once;
 * 4. template sections: content goes into the template section made for it
 *    (same kind, or the template's heading for that resume section); content
 *    the template has no section for goes into one "Additional Information"
 *    section at the end, as bullet points. Sections whose template shows
 *    bullet points get their descriptions as bullets;
 * 5. template order: sections that use template headings follow the
 *    template's order;
 * 6. template facts (page size, columns, fonts, sizes, …) override the AI
 *    where the template analysis has evidence; contact details the template
 *    has no place for are left out (the name is always shown);
 * 7. layout safety (no leading or consecutive page breaks, no page breaks
 *    inside two columns).
 *
 * `issues` describe what was wrong with the AI plan (used for one correction
 * request; they contain references and headings only, never resume text).
 * Content the plan left out is placed automatically and reported in
 * `warnings`, so an incomplete document is never produced silently.
 */

export const NEUTRAL_HEADINGS: Record<PlanSectionKind, string> = {
  summary: "Summary",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certifications: "Certifications",
  awards: "Awards",
  languages: "Languages",
  custom: "Additional Information",
};

const DEFAULT_LAYOUT: Record<PlanSectionKind, SectionLayout> = {
  summary: "paragraph",
  experience: "entries",
  education: "entries",
  skills: "inline",
  projects: "entries",
  certifications: "entries",
  awards: "entries",
  languages: "inline",
  custom: "entries",
};

const MARGIN_INCHES = { narrow: 0.5, normal: 0.75, wide: 1 } as const;
const MARGIN_RANGES = {
  narrow: [0.3, 0.65],
  normal: [0.6, 1.05],
  wide: [0.9, 1.5],
} as const;

export interface FinalizeResult {
  plan: FormattingPlan;
  issues: string[];
  warnings: string[];
}

export interface PlanSource {
  resumeFileId: string;
  templateId: string;
  templateAnalyzedAt: string | null;
  engineVersion: number;
}

const headingKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function finalizePlan(
  aiPlan: AIFormattingPlan,
  content: ResumeContent,
  template: ClientTemplateStructure,
  source: PlanSource,
): FinalizeResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();

  const templateOrder = new Map<string, number>();
  template.sections.forEach((section, index) => {
    const key = headingKey(section.heading);
    if (!templateOrder.has(key)) templateOrder.set(key, index);
  });
  const allowedHeadings = new Set([
    ...templateOrder.keys(),
    ...content.sections.map((section) => headingKey(section.title)),
    ...Object.values(NEUTRAL_HEADINGS).map(headingKey),
  ]);

  // 1–2: references and headings
  let sections: PlanSection[] = [];
  for (const section of aiPlan.sections) {
    const sources: string[] = [];
    const add = (ref: string) => {
      if (used.has(ref)) {
        issues.push(`Content "${ref}" is placed more than once.`);
        return;
      }
      used.add(ref);
      sources.push(ref);
    };
    for (const ref of section.sources) {
      if (ref === "summary") {
        if (content.summary) add(ref);
        else issues.push(`Reference "summary" does not exist (the resume has no summary).`);
      } else if (/^s\d+$/.test(ref)) {
        const index = Number(ref.slice(1));
        const resumeSection = content.sections[index];
        if (!resumeSection) issues.push(`Reference "${ref}" does not exist.`);
        else resumeSection.entries.forEach((_entry, e) => add(entryRef(index, e)));
      } else if (resolveEntryRef(content, ref)) {
        add(ref);
      } else {
        issues.push(`Reference "${ref}" does not exist.`);
      }
    }
    if (sources.length === 0) continue;

    let heading = section.heading;
    if (!allowedHeadings.has(headingKey(heading))) {
      issues.push(
        `Heading "${heading}" is not a template heading or a resume section title; use one of those.`,
      );
      heading = fallbackHeading(sources, section.kind, content, template);
    }
    sections.push({ ...section, heading, sources });
  }

  // 3: completeness
  const missing = requiredRefs(content).filter((ref) => !used.has(ref));
  for (const ref of missing) issues.push(`Content "${ref}" is not placed in any section.`);
  if (missing.length > 0) {
    sections = placeMissing(sections, missing, content, template, warnings);
  }

  // 4: template sections, plus "Additional Information" for everything else
  const fitted = fitToTemplate(sections, content, template, warnings);
  sections = fitted.sections;

  // 5: template order
  const ranks = sections.map((section) => templateOrder.get(headingKey(section.heading)));
  const ranked = ranks.filter((rank): rank is number => rank !== undefined);
  if (ranked.some((rank, i) => i > 0 && rank < ranked[i - 1]!)) {
    issues.push("Sections that use template headings must follow the template's section order.");
    sections = reorderByTemplate(sections, ranks);
  }
  if (fitted.additional) sections.push(fitted.additional);

  // 6–7: template facts and layout safety
  const plan = applyTemplateFacts({ ...aiPlan, sections, source }, template, content);
  const hidden = presentContactFields(content).filter(
    (field) => field !== "fullName" && !plan.header.fields.includes(field),
  );
  if (hidden.length > 0) {
    warnings.push(
      `Contact details the template has no place for were left out (${hidden.map((field) => CONTACT_LABELS[field]).join(", ")}).`,
    );
  }
  return { plan, issues, warnings };
}

const CONTACT_LABELS: Record<string, string> = {
  headline: "job title",
  email: "email",
  phone: "phone",
  location: "location",
  links: "links",
};

/** What the template shows for a section: bullet points, running text, or nothing said. */
function templateUsesBullets(section: TemplateSection): boolean | undefined {
  const hints = section.contentHints.join(" ").toLowerCase();
  if (/\bno bullets?\b|\bparagraph|\bprose\b|running text/.test(hints)) return false;
  if (/bullet/.test(hints)) return true;
  return undefined;
}

const sameHeading = (a: string, b: string) => headingKey(a) === headingKey(b);

/** The template section meant for a piece of resume content, if the template has one. */
function templateSectionFor(
  ref: string,
  content: ResumeContent,
  template: ClientTemplateStructure,
): TemplateSection | undefined {
  if (ref === "summary") return template.sections.find((section) => section.kind === "summary");
  const resolved = resolveEntryRef(content, ref);
  if (!resolved) return undefined;
  const title = content.sections[resolved.sectionIndex]!.title;
  const byHeading = template.sections.find((section) => sameHeading(section.heading, title));
  if (byHeading) return byHeading;
  const kind = planKindForSection(content, resolved.sectionIndex);
  return kind === "custom" ? undefined : template.sections.find((section) => section.kind === kind);
}

/** May `ref` stay in the plan section headed `heading`? Only if it is a template section for it. */
function fitsTemplateSection(
  ref: string,
  heading: string,
  content: ResumeContent,
  template: ClientTemplateStructure,
): boolean {
  const target = template.sections.find((section) => sameHeading(section.heading, heading));
  if (!target) return false;
  if (ref === "summary") return target.kind === "summary";
  const resolved = resolveEntryRef(content, ref);
  if (!resolved) return false;
  return (
    sameHeading(content.sections[resolved.sectionIndex]!.title, target.heading) ||
    (target.kind !== "custom" && target.kind === planKindForSection(content, resolved.sectionIndex))
  );
}

/**
 * Keeps content only in template sections made for it; everything else is
 * collected, in plan order, into one bulleted "Additional Information"
 * section (returned separately so it can go last).
 */
function fitToTemplate(
  sections: PlanSection[],
  content: ResumeContent,
  template: ClientTemplateStructure,
  warnings: string[],
): { sections: PlanSection[]; additional: PlanSection | null } {
  const result: PlanSection[] = [];
  const extra: string[] = [];
  const sectionFor = (heading: string, like: PlanSection | undefined, kind: PlanSectionKind) => {
    const existing = result.find((section) => sameHeading(section.heading, heading));
    if (existing) return existing;
    const created: PlanSection = {
      heading,
      kind,
      layout: like?.layout ?? DEFAULT_LAYOUT[kind],
      sources: [],
      textAsBullets: false,
      groupBySource: false,
      column: like?.column ?? "main",
      pageBreakBefore: like?.pageBreakBefore ?? false,
    };
    result.push(created);
    return created;
  };

  for (const section of sections) {
    for (const ref of section.sources) {
      if (fitsTemplateSection(ref, section.heading, content, template)) {
        sectionFor(section.heading, section, section.kind).sources.push(ref);
        continue;
      }
      const target = templateSectionFor(ref, content, template);
      if (target) {
        const like = sections.find((candidate) => sameHeading(candidate.heading, target.heading));
        sectionFor(target.heading, like, target.kind as PlanSectionKind).sources.push(ref);
        continue;
      }
      extra.push(ref);
    }
  }

  // Bullet points wherever the template shows them for that section.
  for (const section of result) {
    const target = template.sections.find((candidate) =>
      sameHeading(candidate.heading, section.heading),
    );
    const evidence = target ? templateUsesBullets(target) : undefined;
    const experienceLike = section.kind === "experience" || section.kind === "projects";
    section.textAsBullets =
      evidence ?? (experienceLike && template.layout.bulletStyle ? true : section.textAsBullets);
    // A list section the template shows as bullets (education, competencies, …)
    // becomes a bullet list; experience-like sections keep their title lines
    // with the details as bullets underneath.
    if (evidence && !experienceLike && section.kind !== "summary" && section.layout !== "table") {
      section.layout = "bullets";
    }
  }

  if (extra.length === 0) return { sections: result, additional: null };
  const resumeOrder = requiredRefs(content);
  extra.sort((a, b) => resumeOrder.indexOf(a) - resumeOrder.indexOf(b));
  const extraTitles = new Set(
    extra.map((ref) => {
      const resolved = ref === "summary" ? null : resolveEntryRef(content, ref);
      return resolved ? content.sections[resolved.sectionIndex]!.title : "Summary";
    }),
  );
  const heading =
    template.sections.find((section) => /\badditional\b/.test(headingKey(section.heading)))
      ?.heading ?? NEUTRAL_HEADINGS.custom;
  warnings.push(
    `Content the template has no section for (${[...extraTitles].join(", ")}) was added under "${heading}" at the end.`,
  );
  return {
    sections: result,
    additional: {
      heading,
      kind: "custom",
      layout: "bullets",
      sources: extra,
      textAsBullets: true,
      groupBySource: true,
      column: "main",
      pageBreakBefore: false,
    },
  };
}

function fallbackHeading(
  sources: string[],
  kind: PlanSectionKind,
  content: ResumeContent,
  template: ClientTemplateStructure,
): string {
  const templateHeading = template.sections.find((section) => section.kind === kind)?.heading;
  if (templateHeading) return templateHeading;
  const first = sources[0] && resolveEntryRef(content, sources[0]);
  if (first) return content.sections[first.sectionIndex]!.title;
  return NEUTRAL_HEADINGS[kind];
}

/** Places refs the plan left out next to related content, or in a new section. */
function placeMissing(
  sections: PlanSection[],
  missing: string[],
  content: ResumeContent,
  template: ClientTemplateStructure,
  warnings: string[],
): PlanSection[] {
  const result = sections.map((section) => ({ ...section, sources: [...section.sources] }));
  const placedTitles = new Set<string>();

  for (const ref of missing) {
    if (ref === "summary") {
      const target = result.find((section) => section.kind === "summary");
      if (target) target.sources.unshift(ref);
      else {
        result.unshift({
          heading: fallbackHeading([], "summary", content, template),
          kind: "summary",
          layout: "paragraph",
          sources: [ref],
          textAsBullets: false,
          groupBySource: false,
          column: "main",
          pageBreakBefore: false,
        });
      }
      placedTitles.add("Summary");
      continue;
    }

    const resolved = resolveEntryRef(content, ref)!;
    const prefix = `s${resolved.sectionIndex}.`;
    const kind = planKindForSection(content, resolved.sectionIndex);
    const title = content.sections[resolved.sectionIndex]!.title;
    placedTitles.add(title);

    const sibling = result.find((section) => section.sources.some((s) => s.startsWith(prefix)));
    const target = sibling ?? result.find((section) => section.kind === kind);
    if (target) {
      // Keep resume order among entries of the same source section.
      const after = target.sources.findLastIndex(
        (s) => s.startsWith(prefix) && Number(s.split(".e")[1]) < resolved.entryIndex,
      );
      if (after >= 0) target.sources.splice(after + 1, 0, ref);
      else if (sibling)
        target.sources.splice(
          target.sources.findIndex((s) => s.startsWith(prefix)),
          0,
          ref,
        );
      else target.sources.push(ref);
    } else {
      result.push({
        heading: fallbackHeading([ref], kind, content, template),
        kind,
        layout: DEFAULT_LAYOUT[kind],
        sources: [ref],
        textAsBullets: false,
        groupBySource: false,
        column: "main",
        pageBreakBefore: false,
      });
    }
  }

  for (const title of placedTitles) {
    warnings.push(`Some content from "${title}" was placed automatically.`);
  }
  return result;
}

/**
 * Stable reorder by template rank. Each template-headed section moves
 * together with the non-template sections that follow it; sections before
 * the first template heading stay first.
 */
function reorderByTemplate(sections: PlanSection[], ranks: (number | undefined)[]): PlanSection[] {
  const chunks: { rank: number; sections: PlanSection[] }[] = [{ rank: -1, sections: [] }];
  sections.forEach((section, index) => {
    const rank = ranks[index];
    if (rank === undefined) chunks.at(-1)!.sections.push(section);
    else chunks.push({ rank, sections: [section] });
  });
  return chunks
    .map((chunk, order) => ({ ...chunk, order }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .flatMap((chunk) => chunk.sections);
}

function symbolFor(style: string | undefined): (typeof BULLET_SYMBOLS)[number] | undefined {
  if (!style) return undefined;
  const direct = BULLET_SYMBOLS.find((symbol) => style.includes(symbol));
  if (direct) return direct;
  const lower = style.toLowerCase();
  if (/dash|hyphen|-/.test(lower)) return "–";
  if (/square/.test(lower)) return "▪";
  if (/hollow|circle|open/.test(lower)) return "◦";
  if (/arrow|>/.test(lower)) return "➢";
  if (/check|tick/.test(lower)) return "✓";
  if (/dot|disc|bullet|round/.test(lower)) return "•";
  return undefined;
}

const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/;

/** Template evidence wins over the AI plan; unknowns keep the plan's choice. */
function applyTemplateFacts(
  plan: FormattingPlan,
  template: ClientTemplateStructure,
  content: ResumeContent,
): FormattingPlan {
  const { layout, typography, header } = template;
  const page = { ...plan.page };
  if (layout.pageSize !== "unknown") page.size = layout.pageSize;
  page.columns = layout.columns;
  if (layout.margins !== "unknown") {
    const [min, max] = MARGIN_RANGES[layout.margins];
    const fallback = MARGIN_INCHES[layout.margins];
    const margins = page.marginsInches;
    const fits = margins && Object.values(margins).every((value) => value >= min && value <= max);
    if (!fits) {
      page.marginsInches = { top: fallback, right: fallback, bottom: fallback, left: fallback };
    }
  }

  const type = { ...plan.typography };
  if (typography.bodyFont && FONT_NAME.test(typography.bodyFont))
    type.bodyFont = typography.bodyFont;
  if (typography.headingFont && FONT_NAME.test(typography.headingFont)) {
    type.headingFont = typography.headingFont;
  }
  if (typography.baseSizePt) type.bodySizePt = typography.baseSizePt;
  if (typography.headingSizePt) type.headingSizePt = typography.headingSizePt;
  if (typography.headingCase === "upper") type.headingCase = "upper";
  if (typography.headingCase === "title") type.headingCase = "title";

  const entries = { ...plan.entries };
  if (layout.dateAlignment === "right") entries.datePosition = "right";
  if (layout.dateAlignment === "inline") entries.datePosition = "inline";

  const bullets = { ...plan.bullets, symbol: symbolFor(layout.bulletStyle) ?? plan.bullets.symbol };
  const dividers = {
    ...plan.dividers,
    underHeadings: layout.sectionDividers ?? plan.dividers.underHeadings,
  };

  // Header: the contact fields the template has, in the plan's order first.
  // The name is always shown; details the template has no place for are not.
  const templateFields = new Set<string>(header.fields);
  const present = presentContactFields(content).filter(
    (field) => field === "fullName" || templateFields.has(field),
  );
  const fields = [
    ...plan.header.fields.filter(
      (field, i, all) => present.includes(field) && all.indexOf(field) === i,
    ),
    ...present.filter((field) => !plan.header.fields.includes(field)),
  ];
  const headerAlignment = header.alignment !== "unknown" ? header.alignment : plan.header.alignment;

  // Layout safety: page breaks never lead, never repeat, never inside columns.
  let previousBreak = false;
  const sections = plan.sections.map((section, index) => {
    const pageBreakBefore =
      page.columns === 1 && index > 0 && section.pageBreakBefore && !previousBreak;
    previousBreak = pageBreakBefore;
    return {
      ...section,
      column: page.columns === 2 ? section.column : ("main" as const),
      pageBreakBefore,
    };
  });

  return {
    ...plan,
    header: { ...plan.header, fields, alignment: headerAlignment },
    sections,
    page,
    typography: type,
    entries,
    bullets,
    dividers,
  };
}
