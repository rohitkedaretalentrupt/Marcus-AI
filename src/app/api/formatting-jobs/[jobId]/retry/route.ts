import { requireApiUser } from "@/lib/auth/session";
import { retryFormattingJob } from "@/server/formatting/formatting-service";
import { scheduleFormattingJob } from "@/server/formatting/schedule-formatting";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { jobId: string };

/** Re-runs a FAILED (or stuck) formatting job. */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const job = await retryFormattingJob(user.id, (await params).jobId);
  scheduleFormattingJob(user.id, job.id);
  return jsonOk(job, { status: 202 });
});
