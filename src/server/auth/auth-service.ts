import "server-only";

import { argon2PasswordHasher, type PasswordHasher } from "@/lib/auth/password";
import type { PublicUser } from "@/lib/auth/types";
import { loginSchema, registerSchema } from "@/lib/auth/validation";
import { AppError, ERROR_CODES } from "@/lib/errors/app-error";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import { DuplicateEmailError, type UserRepository } from "@/server/users/types";
import { prismaUserRepository } from "@/server/users/user-repository";

export interface AuthServiceDeps {
  users: UserRepository;
  passwords: PasswordHasher;
}

const defaultDeps: AuthServiceDeps = {
  users: prismaUserRepository,
  passwords: argon2PasswordHasher,
};

/**
 * Deliberately vague: confirming that an email is registered helps attackers
 * enumerate accounts. Uniform for "exists already" and the unique-index race.
 */
export class RegistrationConflictError extends AppError {
  constructor() {
    super({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      publicMessage: "Unable to create account. An account with these details may already exist.",
      message: "Registration rejected: email already registered",
    });
  }
}

/** Validates untrusted input, hashes the password and creates the user. */
export async function registerUser(
  input: unknown,
  deps: AuthServiceDeps = defaultDeps,
): Promise<PublicUser> {
  const { name, email, password } = parseOrThrow(registerSchema, input);

  if (await deps.users.findCredentialsByEmail(email)) {
    throw new RegistrationConflictError();
  }

  const passwordHash = await deps.passwords.hash(password);
  try {
    return await deps.users.create({ name, email, passwordHash });
  } catch (error) {
    if (error instanceof DuplicateEmailError) throw new RegistrationConflictError();
    throw error;
  }
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * Hash verified when the email is unknown, so "no such user" and "wrong
 * password" take about the same time and cannot be told apart by timing.
 */
function getDummyHash(passwords: PasswordHasher): Promise<string> {
  dummyHashPromise ??= passwords.hash("timing-equalisation-placeholder");
  return dummyHashPromise;
}

/**
 * Returns the user for valid email/password credentials, otherwise null.
 * All failure modes (malformed input, unknown email, OAuth-only account,
 * wrong password) are indistinguishable to the caller.
 */
export async function authenticateWithPassword(
  credentials: unknown,
  deps: AuthServiceDeps = defaultDeps,
): Promise<PublicUser | null> {
  const parsed = loginSchema.safeParse(credentials);
  if (!parsed.success) return null;

  const { email, password } = parsed.data;
  const record = await deps.users.findCredentialsByEmail(email);

  if (!record?.passwordHash) {
    await deps.passwords.verify(await getDummyHash(deps.passwords), password);
    return null;
  }

  const valid = await deps.passwords.verify(record.passwordHash, password);
  return valid ? record.user : null;
}
