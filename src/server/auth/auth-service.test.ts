import { beforeEach, describe, expect, it } from "vitest";

import { argon2PasswordHasher } from "@/lib/auth/password";
import { ValidationError } from "@/lib/errors/app-error";
import { DuplicateEmailError } from "@/server/users/types";
import { InMemoryUserRepository } from "@test/fakes/in-memory-user-repository";

import {
  authenticateWithPassword,
  registerUser,
  RegistrationConflictError,
  type AuthServiceDeps,
} from "./auth-service";

const PASSWORD = "test-only passphrase";
const REGISTRATION = {
  name: "Ada Tester",
  email: "Ada@Example.test",
  password: PASSWORD,
  confirmPassword: PASSWORD,
};

let users: InMemoryUserRepository;
let deps: AuthServiceDeps;

beforeEach(() => {
  users = new InMemoryUserRepository();
  deps = { users, passwords: argon2PasswordHasher };
});

describe("registerUser", () => {
  it("creates a user with a normalised email and a hashed password", async () => {
    const user = await registerUser(REGISTRATION, deps);

    expect(user).toEqual({
      id: expect.any(String),
      name: "Ada Tester",
      email: "ada@example.test",
      image: null,
    });
    expect(user).not.toHaveProperty("passwordHash");

    const stored = users.rows[0]!;
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  it("rejects invalid input with a ValidationError", async () => {
    await expect(
      registerUser({ ...REGISTRATION, confirmPassword: "different passphrase" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(users.rows).toHaveLength(0);
  });

  it("rejects duplicate accounts, case-insensitively, with a non-revealing error", async () => {
    await registerUser(REGISTRATION, deps);

    const attempt = registerUser({ ...REGISTRATION, email: "ADA@example.TEST" }, deps);
    await expect(attempt).rejects.toBeInstanceOf(RegistrationConflictError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      publicMessage: "Unable to create account. An account with these details may already exist.",
    });
    expect(users.rows).toHaveLength(1);
  });

  it("maps a unique-constraint race to the same conflict error", async () => {
    const racingRepo: InMemoryUserRepository = Object.assign(new InMemoryUserRepository(), {
      findCredentialsByEmail: async () => null,
      create: async () => {
        throw new DuplicateEmailError();
      },
    });

    await expect(
      registerUser(REGISTRATION, { users: racingRepo, passwords: argon2PasswordHasher }),
    ).rejects.toBeInstanceOf(RegistrationConflictError);
  });
});

describe("authenticateWithPassword", () => {
  beforeEach(async () => {
    await registerUser(REGISTRATION, deps);
  });

  it("returns the public user for correct credentials (any email casing)", async () => {
    const user = await authenticateWithPassword(
      { email: " ADA@example.test ", password: PASSWORD },
      deps,
    );

    expect(user).toMatchObject({ email: "ada@example.test", name: "Ada Tester" });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("returns null for a wrong password", async () => {
    await expect(
      authenticateWithPassword({ email: "ada@example.test", password: "wrong passphrase" }, deps),
    ).resolves.toBeNull();
  });

  it("returns null for an unknown email", async () => {
    await expect(
      authenticateWithPassword({ email: "nobody@example.test", password: PASSWORD }, deps),
    ).resolves.toBeNull();
  });

  it("returns null for an account without a password (OAuth-only)", async () => {
    users.seedWithoutPassword("oauth@example.test");
    await expect(
      authenticateWithPassword({ email: "oauth@example.test", password: PASSWORD }, deps),
    ).resolves.toBeNull();
  });

  it.each([undefined, null, {}, { email: "ada@example.test" }, { email: 1, password: 2 }])(
    "returns null for malformed credentials %o",
    async (credentials) => {
      await expect(authenticateWithPassword(credentials, deps)).resolves.toBeNull();
    },
  );
});
