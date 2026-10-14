import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTHENTICATED_PATH,
  isProtectedPath,
  loginPathWithCallback,
  safeCallbackPath,
} from "./routes";

describe("isProtectedPath", () => {
  it.each([
    ["/chat", true],
    ["/chat/abc123", true],
    ["/chats", false],
    ["/dashboard", true],
    ["/dashboard/anything", true],
    ["/dashboards", false],
    ["/templates", true],
    ["/templates/abc", true],
    ["/login", false],
    ["/", false],
  ])("%s → %s", (path, expected) => {
    expect(isProtectedPath(path)).toBe(expected);
  });
});

describe("safeCallbackPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeCallbackPath("/dashboard?tab=1")).toBe("/dashboard?tab=1");
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r//evil.example",
    "/%09/evil.example".replace("%09", "\t"),
    "javascript:alert(1)",
    "/login",
    "/register?x=1",
    "",
    null,
    undefined,
  ])("falls back to the default authenticated page for %s", (value) => {
    expect(safeCallbackPath(value)).toBe(DEFAULT_AUTHENTICATED_PATH);
  });
});

describe("loginPathWithCallback", () => {
  it("encodes the callback path", () => {
    expect(loginPathWithCallback("/dashboard/a?b=c")).toBe(
      "/login?callbackUrl=%2Fdashboard%2Fa%3Fb%3Dc",
    );
  });
});
