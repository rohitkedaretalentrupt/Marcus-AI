import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every template endpoint requires a session (no DB needed). */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth/config", () => ({ getAuthOptions: () => ({}) }));

const collection = await import("./route");
const item = await import("./[templateId]/route");
const retry = await import("./[templateId]/retry/route");
const select = await import("../conversations/[conversationId]/template/route");

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/templates", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const tpl = { params: Promise.resolve({ templateId: "abc" }) };

describe("template API without a session", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    ["GET /api/templates", () => collection.GET(req("GET"), { params: Promise.resolve({}) })],
    [
      "POST /api/templates",
      () =>
        collection.POST(req("POST", { name: "x", fileId: "f" }), { params: Promise.resolve({}) }),
    ],
    ["GET /api/templates/:id", () => item.GET(req("GET"), tpl)],
    ["DELETE /api/templates/:id", () => item.DELETE(req("DELETE"), tpl)],
    ["POST /api/templates/:id/retry", () => retry.POST(req("POST"), tpl)],
    [
      "PUT /api/conversations/:id/template",
      () =>
        select.PUT(req("PUT", { templateId: null }), {
          params: Promise.resolve({ conversationId: "c" }),
        }),
    ],
  ])("%s → 401", async (_name, call) => {
    expect((await call()).status).toBe(401);
  });
});
