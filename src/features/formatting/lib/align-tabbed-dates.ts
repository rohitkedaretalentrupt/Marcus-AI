const DATE_LIKE = /\b(?:19|20)\d{2}\b|\b(?:present|current|till date|to date)\b/i;
const MAX_DATE_CHARS = 40;

/** A run holding only the tab docx-preview draws (an em space), nothing else. */
const isTab = (node: ChildNode): node is HTMLElement =>
  node instanceof HTMLElement && /^[\s ]+$/.test(node.textContent ?? "") && node.textContent !== "";

/**
 * Templates line a date up with a run of tab characters ("Employer⇥⇥⇥ 2021"),
 * which docx-preview draws as plain spaces: the date lands wherever the
 * spaces end. For a line that ends in a date, the text before the tabs and the
 * date become the two ends of one row, so the date sits at the right edge.
 * Only the preview changes; the Word file keeps its own tab stops.
 */
export function alignTabbedDates(container: HTMLElement): void {
  for (const paragraph of container.querySelectorAll<HTMLElement>("p")) {
    const nodes = [...paragraph.childNodes];
    const tabs = nodes.filter(isTab);
    if (tabs.length === 0) continue;
    const lastTab = nodes.lastIndexOf(tabs.at(-1)!);
    const firstTab = nodes.indexOf(tabs[0]!);
    const before = nodes.slice(0, firstTab);
    const after = nodes.slice(lastTab + 1);
    const dateText = after
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    const beforeText = before
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    if (!beforeText || !dateText || dateText.length > MAX_DATE_CHARS || !DATE_LIKE.test(dateText))
      continue;

    const left = document.createElement("span");
    left.style.cssText = "flex: 1 1 auto; min-width: 0;";
    left.append(...before);
    const right = document.createElement("span");
    right.style.cssText = "flex: none; white-space: nowrap; margin-left: 1em;";
    right.append(...after);
    paragraph.replaceChildren(left, right);
    paragraph.style.display = "flex";
    paragraph.style.alignItems = "baseline";
  }
}
