import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every formatting endpoint requires a session (no DB needed). */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth/config", () => ({ getAuthOptions: () => ({}) }));

const collection = await import("./route");
const item = await import("./[jobId]/route");
const retry = await import("./[jobId]/retry/route");
const download = await import("./[jobId]/download-url/route");
const chatFormat = await import("../conversations/[conversationId]/format/route");

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/formatting-jobs", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const job = { params: Promise.resolve({ jobId: "abc" }) };
const none = { params: Promise.resolve({}) };

describe("formatting API without a session", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    ["GET /api/formatting-jobs", () => collection.GET(req("GET"), none)],
    [
      "POST /api/formatting-jobs",
      () => collection.POST(req("POST", { resumeFileId: "f", templateId: "t" }), none),
    ],
    ["GET /api/formatting-jobs/:id", () => item.GET(req("GET"), job)],
    ["DELETE /api/formatting-jobs/:id", () => item.DELETE(req("DELETE"), job)],
    ["POST /api/formatting-jobs/:id/retry", () => retry.POST(req("POST"), job)],
    ["GET /api/formatting-jobs/:id/download-url", () => download.GET(req("GET"), job)],
    [
      "POST /api/conversations/:id/format",
      () =>
        chatFormat.POST(req("POST", { text: "format" }), {
          params: Promise.resolve({ conversationId: "c" }),
        }),
    ],
  ])("%s → 401", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.text()).not.toMatch(/users\/|stack/);
  });
});
