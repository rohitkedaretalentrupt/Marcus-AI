import { requireApiUser } from "@/lib/auth/session";
import { readFormattedResume } from "@/server/formatting/formatting-service";
import { withErrorHandling } from "@/server/http/route-handler";

type Params = { jobId: string };

export const dynamic = "force-dynamic";

/**
 * The caller's own generated DOCX, for the in-app preview (rendered in the
 * browser). Served inline through the server, so no storage URL or key is
 * exposed and private storage needs no CORS rules.
 */
export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const { bytes, mimeType } = await readFormattedResume(user.id, (await params).jobId);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": "inline",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
