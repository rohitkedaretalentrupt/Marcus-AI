import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { getServerEnv } from "@/lib/config/env.server";
import { PrismaClient } from "@/generated/prisma/client";

function createPrismaClient(): PrismaClient {
  const { databaseUrl } = getServerEnv();
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
    // Query errors are thrown and logged by our error handling (or handled,
    // e.g. unique violations); logging them here too would only add noise.
    log: ["warn"],
  });
}

// Stored on globalThis so dev hot reloads reuse one client instead of
// exhausting PostgreSQL connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Lazily-created Prisma client. All database access goes through this module
 * (and, in later phases, repository functions in `src/server/`) — never from
 * client components.
 */
export function getDb(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}
