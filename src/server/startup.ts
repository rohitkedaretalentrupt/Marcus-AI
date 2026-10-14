import "server-only";

import { getServerEnv } from "@/lib/config/env.server";

import { logger } from "./logger";

/**
 * Startup checks, run once when the Node.js server boots (instrumentation.ts).
 *
 * - The environment is validated immediately (not on the first request). A
 *   missing/invalid variable stops a production server with a message that
 *   names the variables but never prints their values.
 * - In production the AI provider and object storage are required (uploads
 *   and formatting cannot work without them) unless
 *   ALLOW_DISABLED_SERVICES=true is set deliberately.
 * - The hourly storage cleanup is scheduled.
 */
export async function runStartupChecks(): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const stop = (message: string) => {
    logger.error(`Startup configuration error: ${message}`);
    if (production) process.exit(1);
  };

  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    // ConfigurationError messages list variable names and rules only.
    stop(error instanceof Error ? error.message : "invalid environment");
    return;
  }

  const missing = [
    env.ai ? null : "AI provider (AI_PROVIDER, AI_API_KEY)",
    env.storage ? null : "object storage (STORAGE_PROVIDER=r2 and R2_* variables)",
  ].filter((item): item is string => item !== null);

  if (missing.length > 0) {
    if (production && !env.allowDisabledServices) {
      stop(
        `${missing.join(" and ")} not configured. Set them, or set ALLOW_DISABLED_SERVICES=true to start without them.`,
      );
      return;
    }
    logger.warn("Starting with services disabled", { disabled: missing });
  }

  logger.info("Server configuration verified", {
    environment: env.nodeEnv,
    ai: env.ai ? `${env.ai.provider}:${env.ai.model ?? "default model"}` : "disabled",
    storage: env.storage ? env.storage.provider : "disabled",
  });

  if (env.storage && env.storageCleanupEnabled && process.env.NODE_ENV !== "test") {
    const { scheduleStorageCleanup } = await import("./maintenance/storage-cleanup");
    scheduleStorageCleanup();
  }
}
