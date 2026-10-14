import { requireApiUser } from "@/lib/auth/session";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";
import { scheduleTemplateAnalysis } from "@/server/templates/schedule-template-analysis";
import { createTemplate, listTemplates } from "@/server/templates/template-service";

export const dynamic = "force-dynamic";

/** The caller's client templates (newest first, without structure). */
export const GET = withErrorHandling(async () => {
  const user = await requireApiUser();
  return jsonOk(await listTemplates(user.id), {
    headers: { "Cache-Control": "private, no-store" },
  });
});

/**
 * Create a template from an uploaded file: `{ name, fileId }`. The file must
 * have been uploaded (POST /api/files with purpose "template") and confirmed.
 * Analysis runs after the response; poll GET /api/templates/:id.
 */
export const POST = withErrorHandling(async (request) => {
  const user = await requireApiUser();
  enforceRateLimit(`template:${user.id}`, RATE_LIMITS.templateCreatePerUser);
  const template = await createTemplate(user.id, await readJsonBody(request));
  scheduleTemplateAnalysis(user.id, template.id);
  return jsonOk(template, { status: 201 });
});
