import { checkFileLocally } from "@/features/files/lib/check-file";
import { confirmUpload, requestUpload, uploadToStorage } from "@/features/files/lib/file-api";
import { apiFetch } from "@/lib/api/client";
import { conversationApi } from "@/lib/chat/routes";
import type { FileSummary } from "@/lib/files/types";
import { TEMPLATES_API, templateApi } from "@/lib/templates/routes";
import type { TemplateDetail, TemplateSummary } from "@/lib/templates/types";

/** Browser calls to the template API. The server derives the user from the session. */

export const listTemplates = () => apiFetch<TemplateSummary[]>(TEMPLATES_API, { method: "GET" });

export const getTemplate = (id: string) =>
  apiFetch<TemplateDetail>(templateApi(id), { method: "GET" });

export const createTemplate = (name: string, fileId: string) =>
  apiFetch<TemplateSummary>(TEMPLATES_API, { method: "POST", body: { name, fileId } });

export const retryTemplate = (id: string) =>
  apiFetch<TemplateSummary>(`${templateApi(id)}/retry`, { method: "POST" });

export const deleteTemplate = (id: string) => apiFetch<void>(templateApi(id), { method: "DELETE" });

export const selectConversationTemplate = (conversationId: string, templateId: string | null) =>
  apiFetch<{ templateId: string | null }>(`${conversationApi(conversationId)}/template`, {
    method: "PUT",
    body: { templateId },
  });

export const TEMPLATE_FILE_ACCEPT =
  "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx";

/**
 * Uploads a template file straight to object storage (presigned PUT, same
 * pipeline as chat attachments) with purpose "template", then has the server
 * verify it. Throws an Error with a user-facing message on local validation failure.
 */
export async function uploadTemplateFile(
  file: File,
  options: { signal: AbortSignal; onProgress: (fraction: number) => void },
): Promise<FileSummary> {
  const check = await checkFileLocally(file);
  if (!check.ok) throw new Error(check.error);
  if (check.contentType !== "application/pdf" && !check.contentType.includes("wordprocessingml")) {
    throw new Error("Templates must be PDF or DOCX files.");
  }
  const { file: created, upload } = await requestUpload({
    filename: file.name,
    contentType: check.contentType,
    sizeBytes: file.size,
    purpose: "template",
  });
  await uploadToStorage(upload, file, options);
  return confirmUpload(created.id);
}
