import { describe, expect, it } from "vitest";

import { toSentences } from "./text";

describe("toSentences", () => {
  it("splits running text into sentences without changing any word", () => {
    const text =
      "Inspected forklifts daily. Introduced quick-check routines! Cut errors by 18%. 2 new hires trained?";
    const sentences = toSentences(text);
    expect(sentences).toEqual([
      "Inspected forklifts daily.",
      "Introduced quick-check routines!",
      "Cut errors by 18%.",
      "2 new hires trained?",
    ]);
    expect(sentences.join(" ")).toBe(text);
  });

  it("does not split after abbreviations, initials or decimals", () => {
    expect(
      toSentences(
        "Worked at Acme Inc. Logistics with J. Smith on v2.5 tools, e.g. SAP. Then left.",
      ),
    ).toEqual([
      "Worked at Acme Inc. Logistics with J. Smith on v2.5 tools, e.g. SAP.",
      "Then left.",
    ]);
  });

  it("keeps separate lines separate and ignores empty input", () => {
    expect(toSentences("First line\nSecond line. Third part.")).toEqual([
      "First line",
      "Second line.",
      "Third part.",
    ]);
    expect(toSentences(undefined)).toEqual([]);
    expect(toSentences("  ")).toEqual([]);
  });
});
