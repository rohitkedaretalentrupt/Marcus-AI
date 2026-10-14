import { requireApiUser } from "@/lib/auth/session";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";
import { getTemplatePreview } from "@/server/templates/template-preview";

type Params = { templateId: string };

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/**
 * The caller's own template file for the in-app viewer: a PDF is returned as
 * is (inline), a DOCX as `{ data: { kind: "docx", filename, html } }` with
 * sanitized HTML. The storage key never leaves the server.
 */
export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const preview = await getTemplatePreview(user.id, (await params).templateId);
  if (preview.kind === "docx") {
    return jsonOk(
      { kind: "docx", filename: preview.filename, html: preview.html },
      { headers: PRIVATE },
    );
  }
  return new Response(new Uint8Array(preview.bytes), {
    headers: {
      ...PRIVATE,
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
      "Content-Length": String(preview.bytes.byteLength),
    },
  });
});
