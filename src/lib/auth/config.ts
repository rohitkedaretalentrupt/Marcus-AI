import "server-only";

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { getServerEnv } from "@/lib/config/env.server";
import { authenticateWithPassword } from "@/server/auth/auth-service";
import { clientIp, consumeRateLimit, RATE_LIMITS } from "@/server/http/rate-limit";
import { logger } from "@/server/logger";

import { AUTH_ERROR_CODES } from "./errors";
import { LOGIN_PATH } from "./routes";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

let cachedOptions: NextAuthOptions | undefined;

/**
 * Auth.js (next-auth v4) configuration, built lazily so `next build` does not
 * need AUTH_SECRET.
 *
 * Sessions use the JWT strategy: Auth.js does not support database sessions
 * with the Credentials provider. The token is an encrypted, HttpOnly cookie
 * holding only the user id; the user record is re-read from the database on
 * every request (see `session.ts`), so deleted users lose access immediately.
 *
 * OAuth providers can be appended to `providers` later together with the
 * Prisma adapter (the schema already has the Account table it needs).
 */
export function getAuthOptions(): NextAuthOptions {
  if (cachedOptions) return cachedOptions;

  const env = getServerEnv();

  // next-auth v4 derives its origin and callback URLs from NEXTAUTH_URL.
  // APP_URL is the single source of truth, so mirror it here instead of
  // asking operators to keep two variables in sync.
  process.env.NEXTAUTH_URL ??= env.appUrl;

  cachedOptions = {
    secret: env.authSecret,
    session: {
      strategy: "jwt",
      maxAge: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    // HttpOnly + SameSite=Lax cookies are the default; `Secure` and the
    // `__Secure-` prefix are enforced whenever the app is served over HTTPS.
    useSecureCookies: env.appUrl.startsWith("https://"),
    pages: { signIn: LOGIN_PATH, error: LOGIN_PATH },
    providers: [
      CredentialsProvider({
        id: "credentials",
        name: "Email and password",
        credentials: {
          email: { label: "Email", type: "email" },
          password: { label: "Password", type: "password" },
        },
        async authorize(credentials, req) {
          // Brute-force guard, per client IP and per email (checked before hashing).
          const ip = clientIp(req?.headers as Record<string, unknown> | undefined);
          const email = String(credentials?.email ?? "")
            .trim()
            .toLowerCase()
            .slice(0, 320);
          if (
            !consumeRateLimit(`login-ip:${ip}`, RATE_LIMITS.loginPerIp) ||
            (email && !consumeRateLimit(`login-email:${email}`, RATE_LIMITS.loginPerEmail))
          ) {
            throw new Error(AUTH_ERROR_CODES.RATE_LIMITED);
          }
          try {
            const user = await authenticateWithPassword(credentials);
            return user ? { id: user.id, name: user.name, email: user.email } : null;
          } catch (error) {
            // Database outage etc. must not look like "wrong password", and
            // the raw error must not reach the browser.
            logger.error("Credentials sign-in failed", error);
            throw new Error(AUTH_ERROR_CODES.UNAVAILABLE);
          }
        },
      }),
    ],
    callbacks: {
      // Keep the token minimal: only the user id is needed to resolve the user.
      jwt({ token, user }) {
        if (user) token.sub = user.id;
        return { sub: token.sub, iat: token.iat, exp: token.exp, jti: token.jti };
      },
      session({ session, token }) {
        return { expires: session.expires, user: { id: token.sub ?? "" } };
      },
    },
    logger: {
      error: (code, metadata) => logger.error(`next-auth: ${code}`, metadata),
      warn: (code) => logger.warn(`next-auth: ${code}`),
      debug: () => {},
    },
  };

  return cachedOptions;
}
