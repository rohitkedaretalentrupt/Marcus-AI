import { requireApiUser } from "@/lib/auth/session";
import { createDownloadUrl } from "@/server/files/file-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { fileId: string };

export const dynamic = "force-dynamic";

/** A short-lived signed URL for the caller's own file. Never accepts a storage key. */
export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const download = await createDownloadUrl(user.id, (await params).fileId);
  return jsonOk(download, { headers: { "Cache-Control": "private, no-store" } });
});
