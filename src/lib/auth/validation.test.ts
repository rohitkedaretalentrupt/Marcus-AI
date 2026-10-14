import { describe, expect, it } from "vitest";

import { loginSchema, normalizeEmail, PASSWORD_MIN_LENGTH, registerSchema } from "./validation";

const VALID = {
  name: "Test User",
  email: "test.user@example.test",
  password: "correct horse battery",
  confirmPassword: "correct horse battery",
};

function issuesFor(input: unknown) {
  const result = registerSchema.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), i.message]));
}

describe("registerSchema", () => {
  it("accepts valid input and normalises the email", () => {
    const result = registerSchema.parse({ ...VALID, email: "  Test.User@Example.TEST " });
    expect(result.email).toBe("test.user@example.test");
    expect(result.name).toBe("Test User");
  });

  it("requires a name", () => {
    expect(issuesFor({ ...VALID, name: "   " })).toHaveProperty("name", "Enter your name.");
  });

  it.each(["not-an-email", "missing@tld", "@example.test", "a b@example.test"])(
    "rejects invalid email %s",
    (email) => {
      expect(issuesFor({ ...VALID, email })).toHaveProperty("email");
    },
  );

  it("rejects mismatched password confirmation", () => {
    expect(issuesFor({ ...VALID, confirmPassword: "something else entirely" })).toHaveProperty(
      "confirmPassword",
      "Passwords do not match.",
    );
  });

  it(`requires at least ${PASSWORD_MIN_LENGTH} password characters`, () => {
    const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(issuesFor({ ...VALID, password: short, confirmPassword: short })).toHaveProperty(
      "password",
    );
  });

  it("rejects absurdly long passwords", () => {
    const long = "a".repeat(129);
    expect(issuesFor({ ...VALID, password: long, confirmPassword: long })).toHaveProperty(
      "password",
    );
  });

  it("rejects non-string values from untrusted clients", () => {
    expect(registerSchema.safeParse({ ...VALID, email: { $ne: null } }).success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("normalises the email and does not enforce the new-password policy", () => {
    const result = loginSchema.parse({ email: "USER@Example.test", password: "short" });
    expect(result).toEqual({ email: "user@example.test", password: "short" });
  });

  it("requires both fields", () => {
    expect(loginSchema.safeParse({ email: "", password: "" }).success).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  MiXeD@Example.TEST ")).toBe("mixed@example.test");
  });
});
