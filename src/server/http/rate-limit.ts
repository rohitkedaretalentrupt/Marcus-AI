import "server-only";

import { RateLimitError } from "@/lib/errors/app-error";

/*
 * Fixed-window request limits kept in process memory. The app runs as a
 * single instance (see README "Deployment"), so this is sufficient; a
 * multi-instance deployment would move the counters to PostgreSQL or Redis.
 * Limits reset on restart, which only ever makes them more lenient.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  /** Sign-in attempts per client IP and per email address. */
  loginPerIp: { limit: 30, windowMs: 15 * 60_000 },
  loginPerEmail: { limit: 10, windowMs: 15 * 60_000 },
  /** New accounts per client IP. */
  registerPerIp: { limit: 10, windowMs: 60 * 60_000 },
  /** AI-backed requests per user (paid provider). */
  assistantReplyPerUser: { limit: 40, windowMs: 10 * 60_000 },
  /** Generous: agencies add a whole library of client templates at once (each runs one AI analysis). */
  templateCreatePerUser: { limit: 200, windowMs: 60 * 60_000 },
  formattingCreatePerUser: { limit: 30, windowMs: 60 * 60_000 },
  /** Upload authorisations per user (on top of the pending-upload cap). */
  uploadRequestPerUser: { limit: 300, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

const MAX_TRACKED_KEYS = 50_000;
const windows = new Map<string, { count: number; resetAt: number }>();

function prune(now: number) {
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
  // Still too many (e.g. a flood of distinct keys): drop the oldest entries.
  while (windows.size > MAX_TRACKED_KEYS) windows.delete(windows.keys().next().value!);
}

/** Counts one request for `key`; false when the limit for the current window is exceeded. */
export function consumeRateLimit(key: string, rule: RateLimitRule, now = Date.now()): boolean {
  if (windows.size > MAX_TRACKED_KEYS) prune(now);
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return true;
  }
  window.count++;
  return window.count <= rule.limit;
}

/** Throws a 429 with a safe message when the limit is exceeded. */
export function enforceRateLimit(
  key: string,
  rule: RateLimitRule,
  message = "Too many requests. Please wait a moment and try again.",
): void {
  if (!consumeRateLimit(key, rule)) throw new RateLimitError(message);
}

/** Test helper. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort client IP. DigitalOcean App Platform sets `do-connecting-ip`;
 * other proxies set `x-forwarded-for` (first entry). Only trustworthy behind
 * a proxy that overwrites these headers — which is how the app is deployed.
 */
export function clientIp(headers: Headers | Record<string, unknown> | undefined): string {
  const get = (name: string): string | undefined => {
    if (!headers) return undefined;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const value = headers[name];
    return typeof value === "string" ? value : Array.isArray(value) ? String(value[0]) : undefined;
  };
  const ip =
    get("do-connecting-ip") ?? get("x-forwarded-for")?.split(",")[0] ?? get("x-real-ip") ?? "";
  return ip.trim().slice(0, 64) || "unknown";
}
