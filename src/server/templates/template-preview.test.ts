import { describe, expect, it } from "vitest";

import { sanitizeDocxHtml } from "./template-preview";

describe("sanitizeDocxHtml", () => {
  it("drops images and unsafe links, keeps safe links and text", () => {
    const html = sanitizeDocxHtml(
      [
        '<p><img src="https://tracker.example.test/p.png" /> Name</p>',
        '<p><a href="javascript:alert(1)">bad</a> <a href="https://example.test/x?a=1&amp;b=2">site</a></p>',
        '<p><a href="mailto:jo@example.test">mail</a> <a href="#_Toc1">toc</a> <a id="bookmark"></a></p>',
      ].join(""),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<a>bad</a>");
    expect(html).toContain(
      '<a href="https://example.test/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">site</a>',
    );
    expect(html).toContain('href="mailto:jo@example.test"');
    expect(html).toContain('href="#_Toc1"');
    expect(html).toContain("Name");
  });
});
