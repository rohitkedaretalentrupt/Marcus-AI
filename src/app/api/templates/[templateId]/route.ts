import { requireApiUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors/app-error";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";
import { deleteTemplate, getTemplate } from "@/server/templates/template-service";

type Params = { templateId: string };

export const dynamic = "force-dynamic";

export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const template = await getTemplate(user.id, (await params).templateId);
  if (!template) throw new NotFoundError("Template not found.");
  return jsonOk(template, { headers: { "Cache-Control": "private, no-store" } });
});

/** Deletes the template and its source file; conversations using it are unlinked. */
export const DELETE = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  await deleteTemplate(user.id, (await params).templateId);
  return new Response(null, { status: 204 });
});
