import "server-only";

import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id (the library default; asserted in tests via the `$argon2id$`
 * prefix) with the OWASP-recommended baseline: 19 MiB, 2 iterations,
 * parallelism 1. Parameters are embedded in each PHC hash string, so they can
 * be raised later without invalidating existing hashes.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Never throws for a malformed hash; returns false instead. */
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_OPTIONS),
  verify: async (passwordHash, password) => {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  },
};
