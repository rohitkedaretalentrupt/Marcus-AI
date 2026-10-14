/**
 * Application error hierarchy.
 *
 * Every error carries a stable machine-readable `code` and an HTTP `status`.
 * `publicMessage` is the only text that may ever reach an end user; the regular
 * `message` (and `cause`) are for server logs only.
 */

export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  UPLOAD_NOT_VERIFIED: "UPLOAD_NOT_VERIFIED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  CONFIGURATION: "CONFIGURATION",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface FieldIssue {
  path: string;
  message: string;
}

interface AppErrorOptions {
  code: ErrorCode;
  status: number;
  publicMessage: string;
  /** Detailed message for logs. Defaults to `publicMessage`. */
  message?: string;
  issues?: FieldIssue[];
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly issues?: FieldIssue[];

  constructor(options: AppErrorOptions) {
    super(options.message ?? options.publicMessage, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.publicMessage = options.publicMessage;
    this.issues = options.issues;
  }
}

export class ValidationError extends AppError {
  constructor(issues: FieldIssue[], publicMessage = "The request is invalid.") {
    super({ code: ERROR_CODES.VALIDATION_FAILED, status: 400, publicMessage, issues });
  }
}

export class UnauthorizedError extends AppError {
  constructor(publicMessage = "Authentication is required.") {
    super({ code: ERROR_CODES.UNAUTHORIZED, status: 401, publicMessage });
  }
}

export class ForbiddenError extends AppError {
  constructor(publicMessage = "You do not have access to this resource.") {
    super({ code: ERROR_CODES.FORBIDDEN, status: 403, publicMessage });
  }
}

export class NotFoundError extends AppError {
  constructor(publicMessage = "The requested resource was not found.") {
    super({ code: ERROR_CODES.NOT_FOUND, status: 404, publicMessage });
  }
}

/** Thrown by provider factories for capabilities that are planned but not built yet. */
export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super({
      code: ERROR_CODES.NOT_IMPLEMENTED,
      status: 501,
      publicMessage: "This feature is not available yet.",
      message: `Not implemented: ${feature}`,
    });
  }
}

/** Server misconfiguration (e.g. missing env var). Details stay in logs. */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super({
      code: ERROR_CODES.CONFIGURATION,
      status: 500,
      publicMessage: "The service is temporarily unavailable.",
      message,
    });
  }
}

/** A dependency (e.g. object storage) is not configured or unreachable. */
export class ServiceUnavailableError extends AppError {
  constructor(publicMessage: string, message?: string) {
    super({ code: ERROR_CODES.SERVICE_UNAVAILABLE, status: 503, publicMessage, message });
  }
}

export class RateLimitError extends AppError {
  constructor(publicMessage = "Too many requests. Please wait a moment and try again.") {
    super({ code: ERROR_CODES.RATE_LIMITED, status: 429, publicMessage });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
