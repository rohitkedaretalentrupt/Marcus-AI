/**
 * Tiny byte sequences with real format signatures (no binary fixtures in git).
 * Only the leading bytes matter for signature checks.
 */
const enc = (text: string) => new TextEncoder().encode(text);

export const FILE_BYTES = {
  pdf: enc("%PDF-1.7\n%test-only fixture\n"),
  docx: new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0,
  ]),
  jpeg: new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1,
  ]),
  png: new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]),
  webp: enc("RIFF\x24\x00\x00\x00WEBPVP8 "),
  html: enc("<!doctype html><script>alert(1)</script>"),
  svg: enc('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  exe: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 0x04, 0, 0, 0, 0xff, 0xff, 0, 0]),
} as const;
