import { requireApiUser } from "@/lib/auth/session";
import { confirmUpload } from "@/server/files/file-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";
import { logger } from "@/server/logger";
import { isExtractable } from "@/server/resumes/extraction-service";
import { scheduleResumeExtraction } from "@/server/resumes/schedule-extraction";

type Params = { fileId: string };

/**
 * Called by the browser after its direct upload. The server does not trust
 * that claim: it inspects the stored object (existence, size, type, signature)
 * before marking the file UPLOADED. PDF/DOCX resumes are then queued for text
 * extraction, which runs after this response.
 */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const file = await confirmUpload(user.id, (await params).fileId);

  // Resume extraction is for chat attachments; templates are analysed by the template service.
  if (
    file.purpose === "attachment" &&
    isExtractable(file.mimeType) &&
    file.extractionStatus === null
  ) {
    try {
      const claim = await scheduleResumeExtraction(user.id, file.id);
      return jsonOk({ ...file, status: "PROCESSING", extractionStatus: claim.status });
    } catch (error) {
      // The upload itself succeeded; extraction can be retried via /extraction.
      logger.error("Failed to schedule resume extraction", error, { fileId: file.id });
    }
  }
  return jsonOk(file);
});
