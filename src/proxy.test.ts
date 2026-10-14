import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Test-only fake values.
const AUTH_SECRET = "test-only-auth-secret-0123456789abcdef";
const SESSION_COOKIE = "next-auth.session-token";

vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
vi.stubEnv("APP_URL", "http://localhost:3000");

const { proxy } = await import("./proxy");

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

let validToken: string;

beforeAll(async () => {
  // A real Auth.js session token, encrypted with the configured secret.
  validToken = await encode({ token: { sub: "user123" }, secret: AUTH_SECRET });
});

describe("proxy", () => {
  it("redirects signed-out visitors from protected pages to /login with a callback", async () => {
    const response = await proxy(request("/dashboard/settings?tab=1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3D1",
    );
  });

  it("lets requests with a valid session token through", async () => {
    const response = await proxy(request("/dashboard", validToken));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects a forged or tampered token", async () => {
    const forged = await encode({
      token: { sub: "user123" },
      secret: "a-different-secret-0123456789abcdef",
    });

    for (const token of [forged, `${validToken.slice(0, -4)}AAAA`, "garbage"]) {
      const response = await proxy(request("/dashboard", token));
      expect(response.headers.get("location")).toContain("/login");
    }
  });

  it("does not interfere with public routes", async () => {
    const response = await proxy(request("/login"));
    expect(response.headers.get("location")).toBeNull();
  });
});
