import { fileURLToPath } from "node:url";

import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Live tests call real paid services; run them only via `npm run test:live`.
    exclude: ["**/node_modules/**", "src/**/*.live.test.ts"],
    // Only TEST_* variables are loaded from .env files, so tests can never
    // pick up the development DATABASE_URL or real secrets by accident.
    env: loadEnv(mode, process.cwd(), "TEST_"),
  },
}));
