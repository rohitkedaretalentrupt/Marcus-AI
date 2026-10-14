import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

import { AppError, ERROR_CODES, ForbiddenError } from "@/lib/errors/app-error";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import type { ApiSuccessBody } from "@/types/api";

import { toErrorResponse } from "./errors";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface RouteContext<TParams = Record<string, string | string[]>> {
  params: Promise<TParams>;
}

type RouteHandler<TParams> = (
  request: NextRequest,
  context: RouteContext<TParams> & { requestId: string },
) => Promise<Response>;

/**
 * Wraps an App Router route handler with request-id propagation and
 * consistent, non-leaky error responses. Every API route should use this.
 */
export function withErrorHandling<TParams = Record<string, string | string[]>>(
  handler: RouteHandler<TParams>,
) {
  return async (request: NextRequest, context: RouteContext<TParams>): Promise<Response> => {
    const requestId = crypto.randomUUID();
    try {
      assertSameOrigin(request);
      const response = await handler(request, { ...context, requestId });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    } catch (error) {
      const response = toErrorResponse(error, requestId);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    }
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (on top of SameSite=Lax cookies and the JSON
 * content-type requirement): a browser request that changes state must come
 * from our own origin. Requests without an Origin header (non-browser
 * clients) carry no ambient cookies from another site and are allowed.
 */
function assertSameOrigin(request: Request) {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ForbiddenError("This request is not allowed.");
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let appOrigin: string | null = null;
  try {
    appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
  } catch {
    appOrigin = null;
  }
  if (originUrl.origin === appOrigin || (host !== null && originUrl.host === host)) return;
  throw new ForbiddenError("This request is not allowed.");
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<ApiSuccessBody<T>> {
  return NextResponse.json({ data }, init);
}

/** Reads and validates a JSON request body. Never trust client input unparsed. */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  return parseOrThrow(schema, await readJsonBody(request));
}

/**
 * Reads a JSON body as `unknown`, for callers that validate in a service.
 * Requiring `application/json` also blocks cross-site HTML form posts, which
 * cannot send that content type without a CORS preflight.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AppError({
      code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      status: 415,
      publicMessage: "The request must be sent as JSON.",
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_JSON_BODY_BYTES) {
    throw new AppError({
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      status: 413,
      publicMessage: "The request is too large.",
    });
  }

  // Content-Length can be absent (chunked) or wrong: count the bytes actually read.
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AppError({
          code: ERROR_CODES.PAYLOAD_TOO_LARGE,
          status: 413,
          publicMessage: "The request is too large.",
        });
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError({
      code: ERROR_CODES.BAD_REQUEST,
      status: 400,
      publicMessage: "The request body must be valid JSON.",
    });
  }
}
