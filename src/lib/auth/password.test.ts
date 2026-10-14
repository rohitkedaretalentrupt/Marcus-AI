import { describe, expect, it } from "vitest";

import { argon2PasswordHasher } from "./password";

const PASSWORD = "test-only password 123";

describe("argon2PasswordHasher", () => {
  it("produces an Argon2id hash that does not contain the password", async () => {
    const hash = await argon2PasswordHasher.hash(PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");
    expect(hash).not.toContain(PASSWORD);
  });

  it("salts each hash", async () => {
    const [a, b] = await Promise.all([
      argon2PasswordHasher.hash(PASSWORD),
      argon2PasswordHasher.hash(PASSWORD),
    ]);
    expect(a).not.toBe(b);
  });

  it("verifies the correct password and rejects others", async () => {
    const hash = await argon2PasswordHasher.hash(PASSWORD);

    await expect(argon2PasswordHasher.verify(hash, PASSWORD)).resolves.toBe(true);
    await expect(argon2PasswordHasher.verify(hash, `${PASSWORD} `)).resolves.toBe(false);
  });

  it("returns false (does not throw) for a malformed stored hash", async () => {
    await expect(argon2PasswordHasher.verify("not-a-hash", PASSWORD)).resolves.toBe(false);
  });
});
