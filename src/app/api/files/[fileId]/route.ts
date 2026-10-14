import { requireApiUser } from "@/lib/auth/session";
import { discardUpload } from "@/server/files/file-service";
import { withErrorHandling } from "@/server/http/route-handler";

type Params = { fileId: string };

/** Discard an upload that has not been sent in a message (removes the stored object). */
export const DELETE = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  await discardUpload(user.id, (await params).fileId);
  return new Response(null, { status: 204 });
});
