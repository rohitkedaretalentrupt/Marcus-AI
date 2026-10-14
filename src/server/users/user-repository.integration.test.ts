import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Runs against a REAL PostgreSQL database (never the dev database).
 * Enabled only when TEST_DATABASE_URL is set; prepare it with `npm run db:test:prepare`.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EMAIL_DOMAIN = "@integration.example.test";
const PASSWORD = "test-only passphrase";

describe.skipIf(!TEST_DATABASE_URL)("user repository + auth service (PostgreSQL)", async () => {
  vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL ?? "");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-0123456789abcdef");

  const { getDb } = await import("@/lib/db/client");
  const { prismaUserRepository } = await import("./user-repository");
  const { DuplicateEmailError } = await import("./types");
  const { authenticateWithPassword, registerUser, RegistrationConflictError } =
    await import("@/server/auth/auth-service");

  const cleanup = () => getDb().user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await getDb().$disconnect();
  });

  it("registers, authenticates and never exposes the hash", async () => {
    const email = `Grace${EMAIL_DOMAIN}`;
    const user = await registerUser({
      name: "Grace",
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });

    expect(user).toEqual({
      id: expect.any(String),
      name: "Grace",
      email: email.toLowerCase(),
      image: null,
    });

    const row = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.createdAt).toBeInstanceOf(Date);

    await expect(prismaUserRepository.findPublicById(user.id)).resolves.not.toHaveProperty(
      "passwordHash",
    );
    await expect(
      authenticateWithPassword({ email: email.toUpperCase(), password: PASSWORD }),
    ).resolves.toMatchObject({ id: user.id });
    await expect(
      authenticateWithPassword({ email, password: "wrong passphrase" }),
    ).resolves.toBeNull();
  });

  it("rejects duplicate registration via the service and the unique index", async () => {
    const email = `dup${EMAIL_DOMAIN}`;
    const input = { name: "Dup", email, password: PASSWORD, confirmPassword: PASSWORD };
    await registerUser(input);

    await expect(registerUser(input)).rejects.toBeInstanceOf(RegistrationConflictError);
    // Bypassing the service pre-check still hits the database constraint.
    await expect(
      prismaUserRepository.create({ name: "Dup", email, passwordHash: "x" }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });
});
