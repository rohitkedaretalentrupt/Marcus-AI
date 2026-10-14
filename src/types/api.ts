import type { ErrorCode, FieldIssue } from "@/lib/errors/app-error";

/** Wire format shared by API routes and client code. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    issues?: FieldIssue[];
    /** Correlates a user-reported error with server logs. */
    requestId: string;
  };
}

export type ApiSuccessBody<T> = { data: T };
