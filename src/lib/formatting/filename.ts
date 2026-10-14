import { sanitizeFilename } from "@/lib/utils/filename";

/**
 * Download name for a generated resume: "<Candidate> - <Template>.docx".
 * Both parts are untrusted text, so the result is sanitised (no paths,
 * control or reserved characters, bounded length) and always ends in .docx.
 */
export function generatedFilename(candidateName: string, templateName: string): string {
  const raw = `${candidateName} - ${templateName}`.replace(/[\\/]/g, "-").replace(/\./g, " ");
  const base = sanitizeFilename(raw, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .slice(0, 110)
    .trim();
  return `${base || "Formatted resume"}.docx`;
}
