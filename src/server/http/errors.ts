import "server-only";

import { NextResponse } from "next/server";

import { ERROR_CODES, isAppError } from "@/lib/errors/app-error";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/server/logger";
import type { ApiErrorBody } from "@/types/api";

const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const UNAVAILABLE_MESSAGE = "The service is temporarily unavailable. Please try again shortly.";

/** Prisma codes for "database unreachable / overloaded" (not bugs in the request). */
const DATABASE_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return DATABASE_UNAVAILABLE_CODES.has(error.code);
  }
  return false;
}

/**
 * Converts any thrown value into a safe JSON error response. Only an
 * AppError's `publicMessage` is exposed; everything else (stack traces, Prisma
 * errors, provider errors) is logged server-side and replaced by a generic message.
 */
export function toErrorResponse(error: unknown, requestId: string): NextResponse<ApiErrorBody> {
  if (isAppError(error)) {
    // Client errors (4xx) are expected; only server faults need the stack.
    if (error.status >= 500) {
      logger.error("Request failed", error, { requestId, code: error.code });
    } else {
      logger.warn("Request rejected", { requestId, code: error.code, message: error.message });
    }

    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.publicMessage,
          issues: error.issues,
          requestId,
        },
      },
      { status: error.status },
    );
  }

  if (isDatabaseUnavailable(error)) {
    logger.error("Database unavailable", error, { requestId });
    return NextResponse.json(
      { error: { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: UNAVAILABLE_MESSAGE, requestId } },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }

  logger.error("Unhandled error", error, { requestId });
  return NextResponse.json(
    { error: { code: ERROR_CODES.INTERNAL, message: GENERIC_MESSAGE, requestId } },
    { status: 500 },
  );
}
