import { requireApiUser } from "@/lib/auth/session";
import { createFormattingJob, listFormattingJobs } from "@/server/formatting/formatting-service";
import { scheduleFormattingJob } from "@/server/formatting/schedule-formatting";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/** The caller's recent formatting jobs (newest first). */
export const GET = withErrorHandling(async () => {
  const user = await requireApiUser();
  return jsonOk(await listFormattingJobs(user.id), {
    headers: { "Cache-Control": "private, no-store" },
  });
});

/**
 * Format a resume with a client template: `{ resumeFileId, templateId }`.
 * Both must belong to the caller and be READY. Processing runs after the
 * response (202); poll GET /api/formatting-jobs/:id. If the same resume and
 * template are already being formatted, that job is returned (200).
 */
export const POST = withErrorHandling(async (request) => {
  const user = await requireApiUser();
  enforceRateLimit(`format:${user.id}`, RATE_LIMITS.formattingCreatePerUser);
  const { job, created } = await createFormattingJob(user.id, await readJsonBody(request));
  if (created) scheduleFormattingJob(user.id, job.id);
  return jsonOk(job, { status: created ? 202 : 200 });
});
