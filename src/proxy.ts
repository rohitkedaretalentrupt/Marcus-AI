import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";

import { isProtectedPath, loginPathWithCallback } from "@/lib/auth/routes";
import { getServerEnv } from "@/lib/config/env.server";

/**
 * Optimistic route protection: redirects visitors without a valid session
 * cookie away from protected pages before anything renders. It is NOT the
 * security boundary — pages and route handlers still call `requireUser()` /
 * `requireApiUser()`, which also confirm the user exists in the database.
 *
 * Signed-in users are redirected away from /login and /register by those
 * pages themselves (after a database check), which avoids redirect loops when
 * a cookie outlives its user.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  const { authSecret, appUrl } = getServerEnv();
  const token = await getToken({
    req: request,
    secret: authSecret,
    secureCookie: appUrl.startsWith("https://"),
  });

  if (!token?.sub) {
    const loginUrl = new URL(loginPathWithCallback(`${pathname}${search}`), request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Must be a static literal; keep in sync with PROTECTED_PATH_PREFIXES.
  matcher: ["/chat/:path*", "/dashboard/:path*", "/templates/:path*"],
};
