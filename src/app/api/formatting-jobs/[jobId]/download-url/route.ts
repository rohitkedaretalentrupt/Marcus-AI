import { requireApiUser } from "@/lib/auth/session";
import { createFormattedDownloadUrl } from "@/server/formatting/formatting-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { jobId: string };

export const dynamic = "force-dynamic";

/** A short-lived signed URL for the caller's own generated DOCX. Never accepts a storage key. */
export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const download = await createFormattedDownloadUrl(user.id, (await params).jobId);
  return jsonOk(download, { headers: { "Cache-Control": "private, no-store" } });
});
