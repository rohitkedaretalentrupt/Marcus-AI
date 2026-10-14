import "server-only";

import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

import { assertSafeDocxPackage } from "@/lib/documents/docx/package-safety";
import type { DocumentTextExtractor, ExtractedDocument } from "@/lib/documents/types";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Pages beyond this are ignored: resumes are short, and this bounds CPU per file. */
const MAX_PDF_PAGES = 30;

/** Text-layer extraction with pdf.js (via unpdf). Scanned PDFs have no text layer → empty text. */
export const pdfTextExtractor: DocumentTextExtractor = {
  supports: (mimeType) => mimeType === PDF,
  async extract(data): Promise<ExtractedDocument> {
    // pdf.js may transfer/detach the buffer; give it its own copy.
    const pdf = await getDocumentProxy(new Uint8Array(data));
    try {
      const pageCount = pdf.numPages;
      const pages: string[] = [];
      for (let number = 1; number <= Math.min(pageCount, MAX_PDF_PAGES); number++) {
        const page = await pdf.getPage(number);
        const { items } = await page.getTextContent();
        let text = "";
        for (const item of items) {
          if (!("str" in item)) continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
          else if (item.str && !item.str.endsWith(" ")) text += " ";
        }
        pages.push(text);
      }
      return { text: pages.join("\n\n"), pageCount };
    } finally {
      // Releases the document and its worker resources.
      await pdf.loadingTask.destroy();
    }
  },
};

/** Raw paragraph text from the DOCX body (mammoth). Formatting is intentionally ignored. */
export const docxTextExtractor: DocumentTextExtractor = {
  supports: (mimeType) => mimeType === DOCX,
  async extract(data): Promise<ExtractedDocument> {
    await assertSafeDocxPackage(data); // before mammoth decompresses the upload
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: value };
  },
};

const EXTRACTORS: readonly DocumentTextExtractor[] = [pdfTextExtractor, docxTextExtractor];

/** The extractor for a MIME type, or null (e.g. images: OCR is not implemented). */
export function extractorFor(mimeType: string): DocumentTextExtractor | null {
  return EXTRACTORS.find((extractor) => extractor.supports(mimeType)) ?? null;
}
