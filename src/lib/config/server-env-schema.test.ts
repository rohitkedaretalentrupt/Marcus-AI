import { describe, expect, it } from "vitest";

import { formatEnvIssues, serverEnvSchema } from "./server-env-schema";

const DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
// Test-only fake value.
const AUTH_SECRET = "test-only-auth-secret-0123456789abcdef";
const BASE_ENV = { DATABASE_URL, AUTH_SECRET };

describe("serverEnvSchema", () => {
  it("accepts a minimal configuration and disables optional integrations", () => {
    const env = serverEnvSchema.parse(BASE_ENV);

    expect(env.databaseUrl).toBe(DATABASE_URL);
    expect(env.authSecret).toBe(AUTH_SECRET);
    expect(env.nodeEnv).toBe("development");
    expect(env.ai).toBeNull();
    expect(env.storage).toBeNull();
  });

  it("treats empty strings from .env files as unset", () => {
    const env = serverEnvSchema.parse({ ...BASE_ENV, AI_PROVIDER: "", STORAGE_PROVIDER: "" });

    expect(env.ai).toBeNull();
    expect(env.storage).toBeNull();
  });

  it("requires AUTH_SECRET", () => {
    expect(serverEnvSchema.safeParse({ DATABASE_URL }).success).toBe(false);
    expect(serverEnvSchema.safeParse({ DATABASE_URL, AUTH_SECRET: "" }).success).toBe(false);
  });

  it("rejects non-PostgreSQL database URLs", () => {
    expect(serverEnvSchema.safeParse({ ...BASE_ENV, DATABASE_URL: "file:./dev.db" }).success).toBe(
      false,
    );
  });

  it("builds the MiMo config with safe defaults", () => {
    const env = serverEnvSchema.parse({
      ...BASE_ENV,
      AI_PROVIDER: "mimo",
      AI_API_KEY: "sk-test-only",
    });
    expect(env.ai).toEqual({
      provider: "mimo",
      apiKey: "sk-test-only",
      baseUrl: undefined,
      model: undefined,
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      thinking: "disabled",
    });
    expect(
      serverEnvSchema.safeParse({
        ...BASE_ENV,
        AI_PROVIDER: "mimo",
        AI_API_KEY: "k",
        AI_TIMEOUT_MS: "10",
      }).success,
    ).toBe(false);
  });

  it("requires AI_API_KEY when AI_PROVIDER is set", () => {
    const result = serverEnvSchema.safeParse({ ...BASE_ENV, AI_PROVIDER: "mimo" });
    expect(result.success).toBe(false);
  });

  it("requires all R2 settings when STORAGE_PROVIDER=r2", () => {
    const result = serverEnvSchema.safeParse({
      ...BASE_ENV,
      STORAGE_PROVIDER: "r2",
      R2_BUCKET_NAME: "bucket",
    });
    expect(result.success).toBe(false);
  });

  it("derives the R2 endpoint from the account id", () => {
    const env = serverEnvSchema.parse({
      ...BASE_ENV,
      STORAGE_PROVIDER: "r2",
      R2_ACCOUNT_ID: "abc123",
      R2_BUCKET_NAME: "resumes",
      R2_ACCESS_KEY_ID: "test-only-key-id",
      R2_SECRET_ACCESS_KEY: "test-only-secret",
    });
    expect(env.storage).toEqual({
      provider: "r2",
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "resumes",
      accessKeyId: "test-only-key-id",
      secretAccessKey: "test-only-secret",
    });
  });

  it("rejects an account id that could alter the endpoint host", () => {
    const result = serverEnvSchema.safeParse({
      ...BASE_ENV,
      STORAGE_PROVIDER: "r2",
      R2_ACCOUNT_ID: "evil.example/x",
      R2_BUCKET_NAME: "b",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    });
    expect(result.success).toBe(false);
  });

  it("never includes secret values in formatted error output", () => {
    const secret = "short-secret-value";
    const result = serverEnvSchema.safeParse({ DATABASE_URL, AUTH_SECRET: secret });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvIssues(result.error)).not.toContain(secret);
      expect(formatEnvIssues(result.error)).toContain("AUTH_SECRET");
    }
  });

  it("accepts local disk storage in development, with a default folder", () => {
    const env = serverEnvSchema.parse({ ...BASE_ENV, STORAGE_PROVIDER: "local" });
    expect(env.storage).toMatchObject({ provider: "local", rootDir: "storage" });
    const custom = serverEnvSchema.parse({
      ...BASE_ENV,
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: "D:/resume-files",
    });
    expect(custom.storage).toMatchObject({ rootDir: "D:/resume-files" });
  });

  it("refuses local disk storage in production", () => {
    const result = serverEnvSchema.safeParse({
      ...BASE_ENV,
      NODE_ENV: "production",
      STORAGE_PROVIDER: "local",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatEnvIssues(result.error)).toMatch(/development only/);
  });
});
