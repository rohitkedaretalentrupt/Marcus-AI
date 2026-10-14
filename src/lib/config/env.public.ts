import { z } from "zod";

/**
 * Browser-safe configuration. Only `NEXT_PUBLIC_*` variables may appear here;
 * Next.js inlines them into the client bundle at BUILD time, so each one must
 * be referenced explicitly (no dynamic `process.env[key]` access).
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().trim().min(1).default("Marcus AI"),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME || undefined,
});
