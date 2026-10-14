import { describe, expect, it } from "vitest";

import { getFileExtension, sanitizeFilename } from "./filename";

describe("sanitizeFilename", () => {
  it("strips directory components (path traversal)", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\resume.pdf")).toBe("resume.pdf");
  });

  it("removes control and reserved characters", () => {
    expect(sanitizeFilename("my\u0000res<ume>?.docx")).toBe("myres_ume__.docx");
  });

  it("does not allow hidden-file names", () => {
    expect(sanitizeFilename(".env")).toBe("env");
  });

  it("falls back when nothing usable remains", () => {
    expect(sanitizeFilename("../")).toBe("file");
  });

  it("truncates long names while keeping the extension", () => {
    const result = sanitizeFilename(`${"a".repeat(300)}.pdf`);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});

describe("getFileExtension", () => {
  it("returns a lower-cased extension", () => {
    expect(getFileExtension("Resume.PDF")).toBe("pdf");
  });

  it("returns null when there is no extension", () => {
    expect(getFileExtension("resume")).toBeNull();
  });
});
