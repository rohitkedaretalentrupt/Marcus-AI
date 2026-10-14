/**
 * Applies committed migrations to the TEST database (TEST_DATABASE_URL).
 * Non-destructive (`migrate deploy`); never touches DATABASE_URL.
 *
 * Usage: npm run db:test:prepare
 */
import { spawnSync } from "node:child_process";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
