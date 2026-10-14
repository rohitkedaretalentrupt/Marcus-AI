/**
 * Auth.js reports sign-in failures as short codes (`?error=...` or the
 * `error` field of `signIn()`); this maps them to safe, user-facing text.
 * Isomorphic: used by the server config and the client forms.
 */
export const AUTH_ERROR_CODES = {
  /** Built-in Auth.js code for rejected credentials. */
  CREDENTIALS: "CredentialsSignin",
  /** Our code for internal failures (e.g. database unavailable) during sign-in. */
  UNAVAILABLE: "AuthUnavailable",
  /** Our code for too many sign-in attempts. */
  RATE_LIMITED: "TooManyAttempts",
} as const;

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const UNAVAILABLE_MESSAGE = "Sign-in is temporarily unavailable. Please try again shortly.";
const RATE_LIMITED_MESSAGE = "Too many sign-in attempts. Please wait a few minutes and try again.";
const GENERIC_MESSAGE = "Unable to sign in. Please try again.";

export function getAuthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === AUTH_ERROR_CODES.CREDENTIALS) return INVALID_CREDENTIALS_MESSAGE;
  if (code === AUTH_ERROR_CODES.UNAVAILABLE) return UNAVAILABLE_MESSAGE;
  if (code === AUTH_ERROR_CODES.RATE_LIMITED) return RATE_LIMITED_MESSAGE;
  return GENERIC_MESSAGE;
}
