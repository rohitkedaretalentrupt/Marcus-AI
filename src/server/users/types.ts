import type { PublicUser } from "@/lib/auth/types";

export interface UserCredentials {
  user: PublicUser;
  passwordHash: string | null;
}

export interface CreateUserData {
  name: string;
  email: string;
  passwordHash: string;
}

/** Thrown by `create` when the email is already registered. */
export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists");
    this.name = "DuplicateEmailError";
  }
}

/**
 * Data access for users. The interface lets auth logic be tested against an
 * in-memory implementation while production uses Prisma.
 */
export interface UserRepository {
  findPublicById(id: string): Promise<PublicUser | null>;
  /** The only method that returns a password hash; for the auth service only. */
  findCredentialsByEmail(normalizedEmail: string): Promise<UserCredentials | null>;
  create(data: CreateUserData): Promise<PublicUser>;
}
