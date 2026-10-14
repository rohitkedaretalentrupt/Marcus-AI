import "server-only";

import { ConfigurationError } from "@/lib/errors/app-error";

import { formatEnvIssues, serverEnvSchema, type ServerEnv } from "./server-env-schema";

let cachedEnv: ServerEnv | undefined;

/**
 * Validated server-only configuration.
 *
 * Parsed lazily on first use rather than at import time so that `next build`
 * (which imports route modules) does not require production secrets, while a
 * misconfigured server still fails fast on the first request that needs them.
 * The `server-only` import makes any accidental client import a build error.
 */
export function getServerEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;

  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigurationError(
      `Invalid server environment configuration:\n${formatEnvIssues(result.error)}`,
    );
  }

  cachedEnv = result.data;
  return cachedEnv;
}
