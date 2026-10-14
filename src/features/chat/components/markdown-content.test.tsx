import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "./markdown-content";

const render = (text: string, streaming = false) =>
  renderToStaticMarkup(<MarkdownContent text={text} streaming={streaming} />);

describe("MarkdownContent", () => {
  it("renders headings, bullets, numbered lists, emphasis and code blocks", () => {
    const html = render(
      [
        "### Strengths",
        "",
        "- **SQL** and Python",
        "- Clear *impact* metrics",
        "",
        "1. First",
        "2. Second",
        "",
        "Use `docx` here:",
        "",
        "```",
        "- Led a team of 5",
        "```",
      ].join("\n"),
    );
    expect(html).toContain("<h3>Strengths</h3>");
    expect(html).toContain("<li><strong>SQL</strong> and Python</li>");
    expect(html).toContain("<em>impact</em>");
    expect(html).toMatch(/<ol>\s*<li>First<\/li>/);
    expect(html).toContain("<code>docx</code>");
    expect(html).toContain("<pre><code>- Led a team of 5\n</code></pre>");
  });

  it("never renders raw HTML, scripts or event handlers from the reply", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\nHello <b onclick="x()">there</b>',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).toContain("Hello");
  });

  it("drops unsafe link protocols and does not load images", () => {
    const html = render(
      "[click](javascript:alert(1)) [site](https://example.test) ![x](https://tracker.example.test/p.png)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("tracker.example.test");
    expect(html).toContain(
      '<a href="https://example.test" target="_blank" rel="noopener noreferrer nofollow">site</a>',
    );
  });

  it("marks a reply that is still arriving (blinking caret)", () => {
    expect(render("Partial", true)).toContain('class="markdown markdown-streaming"');
    expect(render("Done")).toContain('class="markdown"');
  });
});
