export const LOGIN_PATH = "/login";
export const REGISTER_PATH = "/register";
export const DEFAULT_AUTHENTICATED_PATH = "/chat";
export const CALLBACK_URL_PARAM = "callbackUrl";

/** Every route under these prefixes requires a signed-in user. */
export const PROTECTED_PATH_PREFIXES = ["/chat", "/dashboard", "/templates"] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Returns `value` only if it is a same-origin relative path; otherwise the
 * default. Prevents open redirects via `?callbackUrl=https://evil.example`.
 */
export function safeCallbackPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_AUTHENTICATED_PATH,
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    // Browsers strip tabs/newlines when parsing URLs ("/\t/evil" → "//evil").
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  // Belt and braces: the path must resolve to our own origin.
  try {
    const base = "http://same-origin.invalid";
    if (new URL(value, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  // Never bounce back to an auth page after signing in.
  if (value.startsWith(LOGIN_PATH) || value.startsWith(REGISTER_PATH)) return fallback;
  return value;
}

export function loginPathWithCallback(callbackPath: string): string {
  const params = new URLSearchParams({ [CALLBACK_URL_PARAM]: callbackPath });
  return `${LOGIN_PATH}?${params.toString()}`;
}
