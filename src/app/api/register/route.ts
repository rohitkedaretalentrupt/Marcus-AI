import { registerUser } from "@/server/auth/auth-service";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "@/server/http/route-handler";

/**
 * Creates an email/password account (validated inside `registerUser`). The
 * client then signs in through Auth.js; this endpoint never issues a session.
 */
export const POST = withErrorHandling(async (request) => {
  enforceRateLimit(
    `register:${clientIp(request.headers)}`,
    RATE_LIMITS.registerPerIp,
    "Too many sign-up attempts. Please try again later.",
  );
  const user = await registerUser(await readJsonBody(request));
  return jsonOk({ id: user.id }, { status: 201 });
});
