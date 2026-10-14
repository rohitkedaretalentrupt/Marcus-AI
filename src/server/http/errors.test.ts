import { afterEach, describe, expect, it, vi } from "vitest";

import { NotFoundError, ValidationError } from "@/lib/errors/app-error";

import { toErrorResponse } from "./errors";

describe("toErrorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes only the public message of an AppError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = toErrorResponse(new NotFoundError(), "req-1");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
        requestId: "req-1",
      },
    });
  });

  it("includes field issues for validation errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = toErrorResponse(
      new ValidationError([{ path: "name", message: "Required" }]),
      "req-2",
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.issues).toEqual([{ path: "name", message: "Required" }]);
  });

  it("hides details of unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const leaky = new Error("connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5");
    const response = toErrorResponse(leaky, "req-3");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).toContain("INTERNAL");
  });
});

describe("toErrorResponse: database unavailable", () => {
  it("maps an unreachable database to a 503 with a safe message", async () => {
    const { Prisma } = await import("@/generated/prisma/client");
    const { toErrorResponse } = await import("./errors");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Prisma.PrismaClientKnownRequestError(
      "Can't reach database server at db:5432",
      {
        code: "P1001",
        clientVersion: "test",
      },
    );
    const response = toErrorResponse(error, "req-1");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toBe(
      "The service is temporarily unavailable. Please try again shortly.",
    );
    expect(JSON.stringify(body)).not.toContain("db:5432");
  });
});
