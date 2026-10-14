import { z } from "zod";

import { AI_PROVIDER_IDS } from "@/lib/ai/types";
import { STORAGE_PROVIDER_IDS } from "@/lib/storage/types";

/** `.env` files produce "" for `KEY=`; treat that as "not set". */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.url().optional());

function optionalEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), z.enum(values).optional());
}

const rawServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "DATABASE_URL must be a PostgreSQL URL"),

  // Signs and encrypts session tokens. Rotating it signs every user out.
  AUTH_SECRET: z
    .string({ error: "AUTH_SECRET is required" })
    .min(32, "AUTH_SECRET must be at least 32 characters"),

  AI_PROVIDER: optionalEnum(AI_PROVIDER_IDS),
  AI_API_KEY: optionalString,
  AI_BASE_URL: optionalUrl,
  AI_MODEL: optionalString,
  /** Per-request time limit for the AI provider. */
  AI_TIMEOUT_MS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  ),
  /** Upper bound on generated tokens per reply. */
  AI_MAX_OUTPUT_TOKENS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(256).max(32_768).default(4_096),
  ),
  /** Model "thinking" (slower, more deliberate). Reasoning text is never shown or stored. */
  AI_THINKING: optionalEnum(["enabled", "disabled"] as const),

  /**
   * Production refuses to start without the AI provider and object storage,
   * because uploads and formatting cannot work. Set to "true" only for a
   * deliberately partial deployment (e.g. a staging smoke test).
   */
  ALLOW_DISABLED_SERVICES: optionalEnum(["true", "false"] as const),
  /** Set to "false" to turn off the in-process storage cleanup schedule. */
  STORAGE_CLEANUP: optionalEnum(["true", "false"] as const),

  STORAGE_PROVIDER: optionalEnum(STORAGE_PROVIDER_IDS),
  // Cloudflare R2 (S3-compatible API). Server-only: never NEXT_PUBLIC_.
  // The account id becomes part of a hostname, so it is strictly validated.
  R2_ACCOUNT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-z0-9]{1,64}$/i, "R2_ACCOUNT_ID must be the alphanumeric account id")
      .optional(),
  ),
  /** Overrides the endpoint derived from R2_ACCOUNT_ID (e.g. a jurisdiction-specific one). */
  R2_ENDPOINT: optionalUrl,
  R2_BUCKET_NAME: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  /** STORAGE_PROVIDER=local only: folder for stored files (development only). */
  LOCAL_STORAGE_DIR: optionalString,
});

type RawServerEnv = z.infer<typeof rawServerEnvSchema>;

function requireWhen(
  env: RawServerEnv,
  condition: boolean,
  keys: (keyof RawServerEnv)[],
  reason: string,
  ctx: z.RefinementCtx,
) {
  if (!condition) return;
  for (const key of keys) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when ${reason}` });
    }
  }
}

export const serverEnvSchema = rawServerEnvSchema
  .superRefine((env, ctx) => {
    requireWhen(env, env.AI_PROVIDER !== undefined, ["AI_API_KEY"], "AI_PROVIDER is set", ctx);
    const usesR2 = env.STORAGE_PROVIDER === "r2";
    requireWhen(
      env,
      usesR2,
      ["R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
      "STORAGE_PROVIDER=r2",
      ctx,
    );
    if (env.STORAGE_PROVIDER === "local" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_PROVIDER"],
        message: "STORAGE_PROVIDER=local is for development only; use r2 in production",
      });
    }
    if (usesR2 && !env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["R2_ACCOUNT_ID"],
        message: "R2_ACCOUNT_ID (or R2_ENDPOINT) is required when STORAGE_PROVIDER=r2",
      });
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    appUrl: env.APP_URL,
    databaseUrl: env.DATABASE_URL,
    authSecret: env.AUTH_SECRET,
    allowDisabledServices: env.ALLOW_DISABLED_SERVICES === "true",
    storageCleanupEnabled: env.STORAGE_CLEANUP !== "false",
    ai:
      env.AI_PROVIDER && env.AI_API_KEY
        ? {
            provider: env.AI_PROVIDER,
            apiKey: env.AI_API_KEY,
            baseUrl: env.AI_BASE_URL,
            model: env.AI_MODEL,
            timeoutMs: env.AI_TIMEOUT_MS,
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
            thinking: env.AI_THINKING ?? "disabled",
          }
        : null,
    storage:
      env.STORAGE_PROVIDER === "local"
        ? {
            provider: "local" as const,
            rootDir: env.LOCAL_STORAGE_DIR ?? "storage",
            // Signs upload/download links; derived so it differs from the session secret.
            signingKey: `local-storage:${env.AUTH_SECRET}`,
          }
        : env.STORAGE_PROVIDER === "r2" &&
            env.R2_BUCKET_NAME &&
            env.R2_ACCESS_KEY_ID &&
            env.R2_SECRET_ACCESS_KEY &&
            (env.R2_ENDPOINT || env.R2_ACCOUNT_ID)
          ? {
              provider: "r2" as const,
              endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              bucket: env.R2_BUCKET_NAME,
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            }
          : null,
  }));

export type ServerEnv = z.output<typeof serverEnvSchema>;
export type AIConfig = NonNullable<ServerEnv["ai"]>;
export type StorageConfig = NonNullable<ServerEnv["storage"]>;

/**
 * Error output lists variable names only — never values — so it is safe to log.
 */
export function formatEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
    .join("\n");
}
