import { describe, expect, it } from "vitest";

import { deriveConversationTitle } from "./title";
import { DEFAULT_CONVERSATION_TITLE } from "./validation";

describe("deriveConversationTitle", () => {
  it("uses the first non-empty line, whitespace-collapsed", () => {
    expect(deriveConversationTitle("\n   Format   my resume\nfor Client A")).toBe(
      "Format my resume",
    );
  });

  it("truncates long lines at a word boundary with an ellipsis", () => {
    const title = deriveConversationTitle(
      "Please make the experience section of my resume much more professional and concise",
    );
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe("Please make the experience section of my resume much more…");
  });

  it("falls back to the default title", () => {
    expect(deriveConversationTitle("  \n ")).toBe(DEFAULT_CONVERSATION_TITLE);
  });
});
