import { apiFetch } from "@/lib/api/client";
import { conversationApi } from "@/lib/chat/routes";
import { FORMATTING_JOBS_API, formattingJobApi } from "@/lib/formatting/routes";
import type { FormattingJobView } from "@/lib/formatting/types";

/** Browser calls to the formatting API. The server derives the user from the session. */

export const createFormattingJob = (resumeFileId: string, templateId: string) =>
  apiFetch<FormattingJobView>(FORMATTING_JOBS_API, {
    method: "POST",
    body: { resumeFileId, templateId },
  });

/** Format from a chat: the resume/template default to the chat's newest resume and selected template. */
export const startChatFormatting = (
  conversationId: string,
  body: { resumeFileId?: string; templateId?: string; text?: string },
) =>
  apiFetch<FormattingJobView>(`${conversationApi(conversationId)}/format`, {
    method: "POST",
    body,
  });

export const retryFormattingJob = (id: string) =>
  apiFetch<FormattingJobView>(`${formattingJobApi(id)}/retry`, { method: "POST" });

/** Fetches a short-lived signed URL and starts the download (the file is never public). */
export async function downloadFormattedResume(id: string): Promise<void> {
  const { url } = await apiFetch<{ url: string; expiresAt: string; filename: string }>(
    `${formattingJobApi(id)}/download-url`,
    { method: "GET" },
  );
  window.location.assign(url);
}
