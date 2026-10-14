import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIp, consumeRateLimit, enforceRateLimit, resetRateLimits } from "./rate-limit";
import { jsonOk, readJsonBody, withErrorHandling } from "./route-handler";

const handler = withErrorHandling(async (request) => jsonOk(await readJsonBody(request)));
const ctx = { params: Promise.resolve({}) };

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", ...headers },
    body,
    // Streams require half-duplex in Node's fetch implementation.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

describe("withErrorHandling: origin check", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows same-origin and Origin-less requests", async () => {
    expect((await handler(post("{}", { origin: "http://localhost:3000" }), ctx)).status).toBe(200);
    expect((await handler(post("{}"), ctx)).status).toBe(200);
  });

  it("allows the configured APP_URL origin (e.g. behind a proxy)", async () => {
    vi.stubEnv("APP_URL", "https://resumes.example.test");
    const request = post("{}", { origin: "https://resumes.example.test", host: "10.0.0.5:3000" });
    expect((await handler(request, ctx)).status).toBe(200);
  });

  it.each(["https://evil.example", "null", "http://localhost:3000.evil.example"])(
    "rejects a state-changing request from %s with 403",
    async (origin) => {
      const response = await handler(post("{}", { origin }), ctx);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/stack|Error:/);
    },
  );
});

describe("readJsonBody: size limit", () => {
  it("rejects a body over 1 MB even without Content-Length (streamed)", async () => {
    const chunk = new TextEncoder().encode(`"${"x".repeat(64 * 1024)}`);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 40) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = await handler(post(stream), ctx);
    expect(response.status).toBe(413);
  });

  it("still parses normal JSON", async () => {
    const response = await handler(post(JSON.stringify({ a: "é" })), ctx);
    expect(await response.json()).toEqual({ data: { a: "é" } });
  });
});

describe("rate limits", () => {
  afterEach(() => resetRateLimits());

  it("allows `limit` requests per window, then refuses until the window resets", () => {
    const rule = { limit: 3, windowMs: 1000 };
    const results = [0, 1, 2, 3].map(() => consumeRateLimit("k", rule, 0));
    expect(results).toEqual([true, true, true, false]);
    expect(consumeRateLimit("k", rule, 999)).toBe(false);
    expect(consumeRateLimit("k", rule, 1000)).toBe(true);
    expect(consumeRateLimit("other", rule, 0)).toBe(true);
  });

  it("throws a 429 with a safe message", () => {
    const rule = { limit: 1, windowMs: 60_000 };
    enforceRateLimit("x", rule);
    expect(() => enforceRateLimit("x", rule, "Slow down.")).toThrow(
      expect.objectContaining({ status: 429, publicMessage: "Slow down." }),
    );
  });

  it("derives the client IP from proxy headers", () => {
    expect(clientIp(new Headers({ "do-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).toBe("198.51.100.1");
    expect(clientIp(undefined)).toBe("unknown");
  });
});
