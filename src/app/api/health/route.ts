import { jsonOk, withErrorHandling } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * Liveness probe for Docker / DigitalOcean health checks. Intentionally does
 * not touch the database or reveal version/infrastructure details.
 */
export const GET = withErrorHandling(async () =>
  jsonOk(
    { status: "ok", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  ),
);
