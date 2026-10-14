import type { PublicUser } from "@/lib/auth/types";
import {
  DuplicateEmailError,
  type CreateUserData,
  type UserRepository,
} from "@/server/users/types";

interface StoredUser extends PublicUser {
  passwordHash: string | null;
}

/**
 * A working (not mocked) implementation of `UserRepository` that enforces the
 * same unique-email rule as the database, for fast deterministic tests.
 */
export class InMemoryUserRepository implements UserRepository {
  readonly rows: StoredUser[] = [];
  private nextId = 1;

  async findPublicById(id: string): Promise<PublicUser | null> {
    const row = this.rows.find((user) => user.id === id);
    return row ? toPublic(row) : null;
  }

  async findCredentialsByEmail(normalizedEmail: string) {
    const row = this.rows.find((user) => user.email === normalizedEmail);
    return row ? { user: toPublic(row), passwordHash: row.passwordHash } : null;
  }

  async create(data: CreateUserData): Promise<PublicUser> {
    if (this.rows.some((user) => user.email === data.email)) throw new DuplicateEmailError();
    const row: StoredUser = {
      id: `user${this.nextId++}`,
      name: data.name,
      email: data.email,
      image: null,
      passwordHash: data.passwordHash,
    };
    this.rows.push(row);
    return toPublic(row);
  }

  /** Simulates an OAuth-only account (no password). */
  seedWithoutPassword(email: string): PublicUser {
    const row: StoredUser = {
      id: `user${this.nextId++}`,
      name: null,
      email,
      image: null,
      passwordHash: null,
    };
    this.rows.push(row);
    return toPublic(row);
  }
}

function toPublic({ id, name, email, image }: StoredUser): PublicUser {
  return { id, name, email, image };
}
