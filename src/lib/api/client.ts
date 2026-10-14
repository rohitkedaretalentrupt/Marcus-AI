import { loginPathWithCallback } from "@/lib/auth/routes";
import type { ErrorCode, FieldIssue } from "@/lib/errors/app-error";
import type { ApiErrorBody, ApiSuccessBody } from "@/types/api";

/** A failed call to one of our JSON APIs, carrying the server's safe error fields. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    message: string,
    readonly issues?: FieldIssue[],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** First field-level message if the server reported one, else the general message. */
  get displayMessage(): string {
    return this.issues?.[0]?.message ?? this.message;
  }
}

interface ApiFetchOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

/**
 * Browser-side client for our JSON route handlers. Unwraps `{ data }`, turns
 * `{ error }` into an ApiRequestError, and sends the user to the login page
 * when the session has expired (401).
 */
export async function apiFetch<T>(url: string, { method, body }: ApiFetchOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, "NETWORK", "Couldn't reach the server. Check your connection.");
  }

  if (!response.ok) throw await apiErrorFrom(response);
  if (response.status === 204) return undefined as T;

  const json: unknown = await response.json().catch(() => null);
  return (json as ApiSuccessBody<T>).data;
}

/**
 * The ApiRequestError for a failed response of one of our APIs (reads the
 * `{ error }` body). Sends the user to the login page when the session expired.
 */
export async function apiErrorFrom(response: Response): Promise<ApiRequestError> {
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.assign(loginPathWithCallback(window.location.pathname));
  }
  const json: unknown = await response.json().catch(() => null);
  const error = (json as Partial<ApiErrorBody> | null)?.error;
  return new ApiRequestError(
    response.status,
    error?.code ?? "INTERNAL",
    error?.message ?? "Something went wrong. Please try again.",
    error?.issues,
    error?.requestId,
  );
}
