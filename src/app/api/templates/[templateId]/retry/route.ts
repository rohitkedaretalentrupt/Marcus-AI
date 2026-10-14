import { requireApiUser } from "@/lib/auth/session";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";
import { scheduleTemplateAnalysis } from "@/server/templates/schedule-template-analysis";
import { retryTemplateAnalysis } from "@/server/templates/template-service";

type Params = { templateId: string };

/** Re-runs analysis for a FAILED (or stuck) template. */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const template = await retryTemplateAnalysis(user.id, (await params).templateId);
  scheduleTemplateAnalysis(user.id, template.id);
  return jsonOk(template, { status: 202 });
});
