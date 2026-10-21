import { describe, expect, it } from "vitest";

import {
  looksLikeFormatRequest,
  matchTemplateName,
  matchTemplateNames,
  requestedTemplateName,
} from "./chat-request";

describe("looksLikeFormatRequest", () => {
  it.each([
    "Format my resume using Client A template",
    "please reformat this",
    "Can you format it like the Acme one?",
    "Formatting with Client B please",
    "apply the Client A template to my CV",
  ])("recognises %j", (text) => {
    expect(looksLikeFormatRequest(text)).toBe(true);
  });

  it.each([
    "What does my experience section say?",
    "Make it ATS-friendly",
    "Is the information correct?",
    "platformation", // no false positive inside other words
  ])("ignores %j", (text) => {
    expect(looksLikeFormatRequest(text)).toBe(false);
  });

  describe("follow-ups in a conversation", () => {
    const templateNames = ["Zillow", "Client A"];
    const offer =
      "I don't have an Abbott template on file — the only one available is **Zillow**.\n\nWant me to go ahead with Zillow instead?";

    it.each(["do it for zillow", "yes", "Yes please!", "ok go ahead", "sure, do it", "Zillow"])(
      "%j answering an offer to format is a request",
      (text) => {
        expect(looksLikeFormatRequest(text, { previousReply: offer, templateNames })).toBe(true);
      },
    );

    it("recognises an offer phrased without a question mark", () => {
      const statement =
        "There's no client template called \"abbott\" — the only one is **Zillow**. Want me to use that one instead, or you can add Abbott on the Templates page and I'll format it with that.";
      expect(looksLikeFormatRequest("yes", { previousReply: statement, templateNames })).toBe(true);
    });

    it.each(["use Zillow", "do it for zillow", "Zillow please", "go with client a"])(
      "%j names a template with an action, even without an offer",
      (text) => {
        expect(looksLikeFormatRequest(text, { templateNames })).toBe(true);
      },
    );

    it.each([
      ["yes", "Here is a rewritten summary. Want me to shorten it?"], // offer, but not formatting
      ["yes", null], // nothing was offered
      ["what's in the Zillow template?", offer], // a question
      ["Zillow", null], // just a name, no offer and no action
      [`Thanks, I will ${"think about it ".repeat(8)}`, offer], // too long to be a go-ahead
    ])("%j is not a request (previous reply %j)", (text, previousReply) => {
      expect(looksLikeFormatRequest(text, { previousReply, templateNames })).toBe(false);
    });
  });
});

describe("matchTemplateName", () => {
  const names = ["Client A", "Client A Executive", "Acme"];

  it("finds the longest template name mentioned, case-insensitively", () => {
    expect(matchTemplateName("format with client a executive please", names)).toBe(
      "Client A Executive",
    );
    expect(matchTemplateName("Format my resume using Client A", names)).toBe("Client A");
    expect(matchTemplateName("use ACME", names)).toBe("Acme");
  });

  it("returns null when no template is named", () => {
    expect(matchTemplateName("format my resume", names)).toBeNull();
    expect(matchTemplateName("anything", [])).toBeNull();
  });
});

describe("matchTemplateNames", () => {
  const names = [
    "Bayer",
    "Ceridian",
    "Meridian Health Systems",
    "Client A",
    "Client A Executive",
    "City of Hope",
    "S & P",
  ];

  it("finds every template named, in order, even with typos or a short form of the name", () => {
    expect(matchTemplateNames("format for ceredian and meridian also", names)).toEqual([
      "Ceridian",
      "Meridian Health Systems",
    ]);
    expect(matchTemplateNames("do it for bayer's", names)).toEqual(["Bayer"]);
    expect(matchTemplateNames("Meridian, then Bayer", names)).toEqual([
      "Meridian Health Systems",
      "Bayer",
    ]);
  });

  it("prefers the longest full name and an exact word over a near spelling", () => {
    expect(matchTemplateNames("format with client a executive please", names)).toEqual([
      "Client A Executive",
    ]);
    // "meridian" is a word of one template and one letter from another: the exact one wins.
    expect(matchTemplateNames("use meridian", names)).toEqual(["Meridian Health Systems"]);
  });

  it("names nothing for ordinary words, and never guesses between equally close names", () => {
    expect(matchTemplateNames("format my resume again please", names)).toEqual([]);
    expect(matchTemplateNames("yes", names)).toEqual([]);
    expect(matchTemplateNames("format for clien", ["Client A", "Client B"])).toEqual([]);
    expect(matchTemplateNames("format for anything", [])).toEqual([]);
  });
});

describe("requestedTemplateName", () => {
  it.each([
    ["format as per abbott", "abbott"],
    ["Format my resume using the Abbott template", "Abbott"],
    ["format it into Acme Corp format.", "Acme Corp"],
    ["format with Client Z", "Client Z"],
  ])("%j asks for %j", (text, name) => {
    expect(requestedTemplateName(text)).toBe(name);
  });

  it.each([
    "format my resume",
    "format it using the selected template",
    "format with it",
    "please reformat this",
    "format my resume for the job",
  ])("%j names no template", (text) => {
    expect(requestedTemplateName(text)).toBeNull();
  });
});
