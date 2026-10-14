import "dotenv/config";

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` (run during install and Docker builds) needs no
    // database, so a missing URL is tolerated here; migrate commands will fail
    // with a clear connection error instead.
    url: process.env.DATABASE_URL ?? "",
  },
});
