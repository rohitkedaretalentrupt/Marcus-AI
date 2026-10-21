import { requireApiUser } from "@/lib/auth/session";
import { cancelFormattingJob } from "@/server/formatting/formatting-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { jobId: string };

/** Stops a queued or running formatting job (it can be retried afterwards). */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  return jsonOk(await cancelFormattingJob(user.id, (await params).jobId));
});
