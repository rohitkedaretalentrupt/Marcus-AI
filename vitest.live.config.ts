import { fileURLToPath } from "node:url";

import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/**
 * LIVE end-to-end tests against the real services configured in .env
 * (MiMo, Cloudflare R2) and the TEST database. Never part of `npm test`.
 * Run deliberately with `npm run test:live` — it makes paid API calls.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@test": fileURLToPath(new URL("./test", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    // All .env variables (AI_*, R2_*, TEST_DATABASE_URL); DATABASE_URL is
    // replaced by TEST_DATABASE_URL inside the test.
    env: { ...loadEnv(mode, process.cwd(), ""), LIVE_E2E: "1" },
  },
}));
