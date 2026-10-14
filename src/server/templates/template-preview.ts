import "server-only";

import mammoth from "mammoth";

import { getDb } from "@/lib/db/client";
import { assertSafeDocxPackage } from "@/lib/documents/docx/package-safety";
import { NotFoundError } from "@/lib/errors/app-error";
import { FILE_LIMITS } from "@/lib/files/limits";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey, StorageProvider } from "@/lib/storage/types";
import { templateIdSchema } from "@/lib/templates/types";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type TemplatePreview =
  | { kind: "pdf"; filename: string; bytes: Uint8Array }
  | { kind: "docx"; filename: string; html: string };

/**
 * Makes mammoth's HTML safe to show. Mammoth escapes all document text and
 * emits only its own small set of tags, so the remaining risks are images
 * (could load remote content) and link targets (e.g. `javascript:`): images
 * are dropped and only http(s)/mailto/#fragment links are kept. The browser
 * also shows the result in a sandboxed iframe with no scripts.
 */
export function sanitizeDocxHtml(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, "").replace(/<a\b[^>]*>/gi, (tag) => {
    const href = /\bhref="([^"]*)"/i.exec(tag)?.[1] ?? "";
    const safe = /^(?:https?:\/\/|mailto:|#)/i.test(href.trim());
    return safe ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">` : "<a>";
  });
}

async function docxToHtml(bytes: Uint8Array): Promise<string> {
  await assertSafeDocxPackage(bytes); // before mammoth decompresses the upload
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      styleMap: ["u => u", "p[style-name='Title'] => h1.title:fresh"],
      // Never embed images (they would arrive as data URIs; the preview is about layout text).
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    },
  );
  return sanitizeDocxHtml(value);
}

/**
 * The client template's original file for viewing: PDF bytes as uploaded, or
 * a DOCX converted to safe HTML. Owner-scoped; anything else is "not found".
 */
export async function getTemplatePreview(
  userId: string,
  templateId: unknown,
  getStorage: () => StorageProvider = getStorageProvider,
): Promise<TemplatePreview> {
  const id = templateIdSchema.safeParse(templateId);
  if (!id.success) throw new NotFoundError("Template not found.");
  const template = await getDb().clientTemplate.findFirst({
    where: { id: id.data, userId },
    select: {
      uploadedFile: { select: { storageKey: true, mimeType: true, originalFilename: true } },
    },
  });
  const file = template?.uploadedFile;
  if (!file || (file.mimeType !== PDF && file.mimeType !== DOCX)) {
    throw new NotFoundError("Template not found.");
  }

  const bytes = await getStorage().getObject(
    file.storageKey as StorageKey,
    FILE_LIMITS.maxFileBytes,
  );
  return file.mimeType === PDF
    ? { kind: "pdf", filename: file.originalFilename, bytes }
    : { kind: "docx", filename: file.originalFilename, html: await docxToHtml(bytes) };
}
