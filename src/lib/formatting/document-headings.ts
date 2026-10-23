import JSZip from "jszip";

const MAX_HEADINGS = 40;
const MAX_LENGTH = 90;
const BELOW_LINES = 3;
const BELOW_CHARS = 70;

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

interface Line {
  text: string;
  heading: boolean;
}

/**
 * The lines of a Word file that stand as headings to a reader (short lines set
 * entirely in bold, or in capitals), each with the first lines shown under it.
 * This is what a person looking at the file calls "the X section", and what is
 * under it tells the chat reader which part of the resume that is.
 */
export async function documentHeadings(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return [];
  const lines: Line[] = [];
  for (const [paragraph] of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const runs = [...paragraph.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((match) => match[0]);
    const text = decode(
      runs.map((run) => [...run.matchAll(/<w:t[^>]*>([^<]*)/g)].map((m) => m[1]).join("")).join(""),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const letters = text.replace(/[^\p{L}]/gu, "");
    const capitals = letters.replace(/[^\p{Lu}]/gu, "");
    const shouting = letters.length >= 4 && capitals.length / letters.length > 0.85;
    const bold = runs
      .filter((run) => /<w:t[ >]/.test(run))
      .every((run) => /<w:b(?: w:val="(?:1|true|on)")?\/>/.test(run));
    const short = text.length >= 3 && text.length <= MAX_LENGTH && !/\b(?:19|20)\d{2}\b/.test(text);
    lines.push({ text, heading: short && (shouting || bold) });
  }
  const headings: string[] = [];
  lines.forEach((line, index) => {
    if (!line.heading || headings.length >= MAX_HEADINGS) return;
    const below = lines
      .slice(index + 1)
      .filter((next) => !next.heading)
      .slice(0, BELOW_LINES)
      .map((next) => next.text.slice(0, BELOW_CHARS));
    headings.push(below.length ? `${line.text} (shows: ${below.join("; ")})` : line.text);
  });
  return headings;
}
