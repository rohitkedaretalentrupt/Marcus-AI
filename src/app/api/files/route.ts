import { requireApiUser } from "@/lib/auth/session";
import { requestUpload } from "@/server/files/file-service";
import { enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

/**
 * Upload authorization: `{ filename, contentType, sizeBytes }` → a file id and
 * a short-lived presigned PUT for a server-generated key. The browser then
 * uploads the bytes directly to object storage (never through this server).
 */
export const POST = withErrorHandling(async (request) => {
  const user = await requireApiUser();
  enforceRateLimit(`upload:${user.id}`, RATE_LIMITS.uploadRequestPerUser);
  const authorization = await requestUpload(user.id, await readJsonBody(request));
  return jsonOk(authorization, { status: 201, headers: { "Cache-Control": "no-store" } });
});
