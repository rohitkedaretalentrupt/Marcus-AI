import { describe, expect, it } from "vitest";

import { generatedFilename } from "./filename";

describe("generatedFilename", () => {
  it.each([
    ["Sam Rivera", "Client A", "Sam Rivera - Client A.docx"],
    ["../../etc/passwd", "Client", "etc-passwd - Client.docx"],
    ['Jo <script>"x"</script>', "A|B", "Jo _script__x__-script_ - A_B.docx"],
    ["Ana\u0000 Lee", "C:\\Clients\\Acme", "Ana Lee - C_-Clients-Acme.docx"],
    ["Dr. J. Smith", "Acme.exe", "Dr J Smith - Acme exe.docx"],
    ["", "", "Formatted resume.docx"],
  ])("%j + %j → %j", (name, template, expected) => {
    const result = generatedFilename(name, template);
    expect(result).toBe(expected);
    expect(result).not.toMatch(/[\/<>:"|?*\u0000-\u001f]|\.\./);
  });

  it("bounds the length and always ends in .docx", () => {
    const result = generatedFilename("x".repeat(500), "y".repeat(500));
    expect(result.length).toBeLessThanOrEqual(115);
    expect(result).toMatch(/^x+\.docx$/);
  });
});
