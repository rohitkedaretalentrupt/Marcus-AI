import { getServerSession } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "@/lib/errors/app-error";
import type { InMemoryUserRepository } from "@test/fakes/in-memory-user-repository";

// Boundaries replaced: the Auth.js session lookup (needs a real request) and
// the database (replaced by a working in-memory repository).
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("./config", () => ({ getAuthOptions: () => ({}) }));
vi.mock("@/server/users/user-repository", async () => {
  const { InMemoryUserRepository } = await import("@test/fakes/in-memory-user-repository");
  return { prismaUserRepository: new InMemoryUserRepository() };
});

const { getCurrentUser, requireApiUser, requireUser } = await import("./session");
const repo = (await import("@/server/users/user-repository"))
  .prismaUserRepository as InMemoryUserRepository;
const mockedGetServerSession = vi.mocked(getServerSession);

function sessionFor(userId: string) {
  return { user: { id: userId }, expires: new Date(Date.now() + 60_000).toISOString() };
}

let existingUserId: string;

beforeEach(async () => {
  repo.rows.length = 0;
  existingUserId = (
    await repo.create({ name: "Ada", email: "ada@example.test", passwordHash: "$argon2id$test" })
  ).id;
  mockedGetServerSession.mockReset();
});

/** Next.js `redirect()` throws a special error whose digest encodes the target. */
async function expectRedirect(promise: Promise<unknown>, path: string) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining(`;${path};`),
  });
}

describe("getCurrentUser", () => {
  it("returns null without a session", async () => {
    mockedGetServerSession.mockResolvedValue(null);
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns the public user for a valid session", async () => {
    mockedGetServerSession.mockResolvedValue(sessionFor(existingUserId));
    const user = await getCurrentUser();

    expect(user).toEqual({
      id: existingUserId,
      name: "Ada",
      email: "ada@example.test",
      image: null,
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("returns null when the session's user no longer exists", async () => {
    mockedGetServerSession.mockResolvedValue(sessionFor("deleted-user"));
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  it("returns the user when signed in", async () => {
    mockedGetServerSession.mockResolvedValue(sessionFor(existingUserId));
    await expect(requireUser()).resolves.toMatchObject({ id: existingUserId });
  });

  it("redirects to /login when signed out", async () => {
    mockedGetServerSession.mockResolvedValue(null);
    await expectRedirect(requireUser(), "/login");
  });

  it("redirects to /login for a stale session of a deleted user", async () => {
    mockedGetServerSession.mockResolvedValue(sessionFor("deleted-user"));
    await expectRedirect(requireUser(), "/login");
  });
});

describe("requireApiUser", () => {
  it("throws a 401 UnauthorizedError when signed out", async () => {
    mockedGetServerSession.mockResolvedValue(null);
    await expect(requireApiUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
