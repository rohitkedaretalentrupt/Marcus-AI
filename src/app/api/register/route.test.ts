import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InMemoryUserRepository } from "@test/fakes/in-memory-user-repository";

// Only the database is replaced; validation, hashing and HTTP mapping are real.
vi.mock("@/server/users/user-repository", async () => {
  const { InMemoryUserRepository } = await import("@test/fakes/in-memory-user-repository");
  return { prismaUserRepository: new InMemoryUserRepository() };
});

const { POST } = await import("./route");
const repo = (await import("@/server/users/user-repository"))
  .prismaUserRepository as InMemoryUserRepository;

const PASSWORD = "test-only passphrase";
const BODY = {
  name: "Ada Tester",
  email: "ada@example.test",
  password: PASSWORD,
  confirmPassword: PASSWORD,
};

function post(body: unknown, contentType = "application/json") {
  return POST(
    new NextRequest("http://localhost/api/register", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

afterEach(() => {
  repo.rows.length = 0;
  vi.restoreAllMocks();
});

describe("POST /api/register", () => {
  it("creates the account and returns only its id", async () => {
    const response = await post(BODY);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ data: { id: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain("argon2");
  });

  it("returns field issues for invalid input", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post({
      ...BODY,
      email: "nope",
      confirmPassword: "different passphrase",
    });

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      "confirmPassword",
      "email",
    ]);
  });

  it("rejects a duplicate account with a safe, generic message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(BODY);
    const response = await post({ ...BODY, email: "ADA@example.test" });
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).toContain("An account with these details may already exist.");
    expect(text).not.toMatch(/P2002|unique|prisma/i);
  });

  it("rejects non-JSON bodies (blocks cross-site form posts)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post("name=x", "application/x-www-form-urlencoded");
    expect(response.status).toBe(415);
  });
});
