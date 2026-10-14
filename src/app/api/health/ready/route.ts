import { isAIEnabled } from "@/lib/ai/provider";
import { getDb } from "@/lib/db/client";
import { isStorageEnabled } from "@/lib/storage/provider";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3_000;

/**
 * Readiness probe: the database answers and the configuration is valid.
 * Reports only coarse states (no versions, hosts or error details).
 * Liveness (process up) is GET /api/health.
 */
export async function GET() {
  let config: "ok" | "invalid" = "ok";
  let ai = false;
  let storage = false;
  try {
    ai = isAIEnabled();
    storage = isStorageEnabled();
  } catch {
    config = "invalid";
  }

  let database: "ok" | "unavailable" = "unavailable";
  if (config === "ok") {
    try {
      await Promise.race([
        getDb().$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS)),
      ]);
      database = "ok";
    } catch (error) {
      logger.warn("Readiness check: database unavailable", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const ready = config === "ok" && database === "ok";
  return Response.json(
    {
      status: ready ? "ready" : "unavailable",
      checks: {
        config,
        database,
        ai: ai ? "configured" : "disabled",
        storage: storage ? "configured" : "disabled",
      },
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
