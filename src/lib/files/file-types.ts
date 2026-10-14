/**
 * Supported upload formats — the single source of truth used by the client
 * (picker `accept`, instant feedback) and the server (authoritative checks).
 * Adding a format means adding an entry here, with its magic bytes.
 */

export const FILE_KINDS = ["pdf", "docx", "image"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

interface FileTypeDefinition {
  mimeType: string;
  /** Lower-case, without the dot. The first one is used for the storage key. */
  extensions: readonly string[];
  kind: FileKind;
  label: string;
  /** Returns true when the leading bytes match the format's signature. */
  matchesSignature: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

export const FILE_TYPES = {
  "application/pdf": {
    mimeType: "application/pdf",
    extensions: ["pdf"],
    kind: "pdf",
    label: "PDF",
    matchesSignature: (bytes) => startsWith(bytes, ascii("%PDF-")),
  },
  // A DOCX is a ZIP container. Only the ZIP signature can be checked from the
  // leading bytes; confirming it is really a Word document requires reading
  // the archive, which happens when files are processed (a later phase).
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    kind: "docx",
    label: "Word document",
    matchesSignature: (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]),
  },
  "image/jpeg": {
    mimeType: "image/jpeg",
    extensions: ["jpg", "jpeg"],
    kind: "image",
    label: "JPEG image",
    matchesSignature: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  "image/png": {
    mimeType: "image/png",
    extensions: ["png"],
    kind: "image",
    label: "PNG image",
    matchesSignature: (bytes) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  "image/webp": {
    mimeType: "image/webp",
    extensions: ["webp"],
    kind: "image",
    label: "WebP image",
    matchesSignature: (bytes) =>
      startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8),
  },
} as const satisfies Record<string, FileTypeDefinition>;

export type SupportedMimeType = keyof typeof FILE_TYPES;

export const SUPPORTED_MIME_TYPES = Object.keys(FILE_TYPES) as [
  SupportedMimeType,
  ...SupportedMimeType[],
];

/** Enough leading bytes to check every signature above. */
export const SIGNATURE_BYTES = 16;

/** Value for `<input type="file" accept>` — a UX hint only, never a security control. */
export const FILE_INPUT_ACCEPT = [
  ...SUPPORTED_MIME_TYPES,
  ...Object.values(FILE_TYPES).flatMap((type) => type.extensions.map((ext) => `.${ext}`)),
].join(",");

export function isSupportedMimeType(value: string): value is SupportedMimeType {
  return Object.hasOwn(FILE_TYPES, value);
}

export function getFileType(mimeType: SupportedMimeType): FileTypeDefinition {
  return FILE_TYPES[mimeType];
}

/** The supported type whose extension list contains `extension`, if any. */
export function mimeTypeForExtension(extension: string): SupportedMimeType | null {
  const ext = extension.toLowerCase();
  return SUPPORTED_MIME_TYPES.find((mime) => getFileType(mime).extensions.includes(ext)) ?? null;
}

export function fileKindOf(mimeType: string): FileKind | null {
  return isSupportedMimeType(mimeType) ? getFileType(mimeType).kind : null;
}

export function matchesFileSignature(mimeType: SupportedMimeType, bytes: Uint8Array): boolean {
  return getFileType(mimeType).matchesSignature(bytes);
}
