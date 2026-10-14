import { requireApiUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors/app-error";
import { deleteFormattingJob, getFormattingJob } from "@/server/formatting/formatting-service";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

type Params = { jobId: string };

export const dynamic = "force-dynamic";

export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const job = await getFormattingJob(user.id, (await params).jobId);
  if (!job) throw new NotFoundError("Formatting job not found.");
  return jsonOk(job, { headers: { "Cache-Control": "private, no-store" } });
});

/** Deletes a finished job and its generated document. */
export const DELETE = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  await deleteFormattingJob(user.id, (await params).jobId);
  return new Response(null, { status: 204 });
});
