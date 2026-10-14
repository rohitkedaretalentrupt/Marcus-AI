import { describe, expect, it } from "vitest";

import { FILE_BYTES } from "@test/fixtures/file-bytes";

import {
  FILE_INPUT_ACCEPT,
  isSupportedMimeType,
  matchesFileSignature,
  mimeTypeForExtension,
  SUPPORTED_MIME_TYPES,
  type SupportedMimeType,
} from "./file-types";

const VALID: [SupportedMimeType, Uint8Array][] = [
  ["application/pdf", FILE_BYTES.pdf],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", FILE_BYTES.docx],
  ["image/jpeg", FILE_BYTES.jpeg],
  ["image/png", FILE_BYTES.png],
  ["image/webp", FILE_BYTES.webp],
];

describe("file signatures (magic bytes)", () => {
  it.each(VALID)("accepts a real %s signature", (mime, bytes) => {
    expect(matchesFileSignature(mime, bytes)).toBe(true);
  });

  it("rejects every format's bytes under every other type", () => {
    for (const [mime] of VALID) {
      for (const [otherMime, bytes] of VALID) {
        if (otherMime !== mime) expect(matchesFileSignature(mime, bytes)).toBe(false);
      }
    }
  });

  it.each([
    ["HTML renamed to .pdf", FILE_BYTES.html],
    ["SVG renamed to .png", FILE_BYTES.svg],
    ["Windows executable", FILE_BYTES.exe],
    ["empty file", new Uint8Array()],
  ])("rejects %s", (_name, bytes) => {
    for (const mime of SUPPORTED_MIME_TYPES) expect(matchesFileSignature(mime, bytes)).toBe(false);
  });
});

describe("supported types", () => {
  it("allows exactly PDF, DOCX, JPEG, PNG and WebP", () => {
    expect([...SUPPORTED_MIME_TYPES].sort()).toEqual(
      [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg",
        "image/png",
        "image/webp",
      ].sort(),
    );
  });

  it.each([
    "image/svg+xml",
    "text/html",
    "application/zip",
    "application/x-msdownload",
    "image/heic",
  ])("does not support %s", (mime) => {
    expect(isSupportedMimeType(mime)).toBe(false);
  });

  it("maps extensions case-insensitively and rejects unknown ones", () => {
    expect(mimeTypeForExtension("JPG")).toBe("image/jpeg");
    expect(mimeTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForExtension("doc")).toBeNull();
    expect(mimeTypeForExtension("svg")).toBeNull();
  });

  it("builds the picker accept list from the registry", () => {
    expect(FILE_INPUT_ACCEPT).toContain("application/pdf");
    expect(FILE_INPUT_ACCEPT).toContain(".docx");
    expect(FILE_INPUT_ACCEPT).not.toContain("svg");
  });
});
