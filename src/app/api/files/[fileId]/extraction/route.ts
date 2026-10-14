import { requireApiUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors/app-error";
import { jsonOk, withErrorHandling } from "@/server/http/route-handler";
import { getResumeExtraction } from "@/server/resumes/extraction-service";
import { scheduleResumeExtraction } from "@/server/resumes/schedule-extraction";

type Params = { fileId: string };

export const dynamic = "force-dynamic";

/** The structured resume extracted from the caller's own file (or its status). */
export const GET = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const extraction = await getResumeExtraction(user.id, (await params).fileId);
  if (!extraction) throw new NotFoundError("No extraction found for this file.");
  return jsonOk(extraction, { headers: { "Cache-Control": "private, no-store" } });
});

/** (Re)run extraction, e.g. after a failure. Returns the claim; work happens after the response. */
export const POST = withErrorHandling<Params>(async (_request, { params }) => {
  const user = await requireApiUser();
  const claim = await scheduleResumeExtraction(user.id, (await params).fileId);
  return jsonOk(claim, { status: 202 });
});
