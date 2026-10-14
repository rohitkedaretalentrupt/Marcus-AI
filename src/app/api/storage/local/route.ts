import { NextResponse } from "next/server";

import { AppError, ERROR_CODES, ForbiddenError, NotFoundError } from "@/lib/errors/app-error";
import { getLocalStorageProvider } from "@/lib/storage/provider";
import type { StorageKey } from "@/lib/storage/types";
import { withErrorHandling } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/*
 * Signed upload/download endpoint for STORAGE_PROVIDER=local (development
 * only). It plays the role of R2's presigned URLs: the token in the query
 * string authorises exactly one operation on one key until it expires, with
 * the content type and byte length fixed by the server. Returns 404 when the
 * local provider is not in use.
 */

function storageOr404() {
  const storage = getLocalStorageProvider();
  if (!storage) throw new NotFoundError();
  return storage;
}

function verify(request: Request, op: "put" | "get") {
  const storage = storageOr404();
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const payload = storage.verifyToken(token);
  if (!payload || payload.op !== op) {
    throw new ForbiddenError("This link is invalid or has expired.");
  }
  return { storage, payload };
}

const normaliseType = (value: string | null) => (value ?? "").split(";")[0]!.trim().toLowerCase();

/** Browser upload (the equivalent of a presigned PUT). */
export const PUT = withErrorHandling(async (request) => {
  const { storage, payload } = verify(request, "put");
  if (payload.op !== "put") throw new ForbiddenError();
  if (normaliseType(request.headers.get("content-type")) !== payload.contentType) {
    throw new ForbiddenError("The file type doesn't match this upload link.");
  }

  // Read the body, never accepting more than the signed length.
  const data = new Uint8Array(payload.length);
  let received = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > payload.length) {
        await reader.cancel().catch(() => {});
        throw new AppError({
          code: ERROR_CODES.PAYLOAD_TOO_LARGE,
          status: 413,
          publicMessage: "The file is larger than declared.",
        });
      }
      data.set(value, received);
      received += value.byteLength;
    }
  }
  if (received !== payload.length) {
    throw new AppError({
      code: ERROR_CODES.BAD_REQUEST,
      status: 400,
      publicMessage: "The file size doesn't match this upload link.",
    });
  }

  await storage.writeUpload(payload.key as StorageKey, data, payload.contentType);
  return new Response(null, { status: 200 });
});

/** Signed download (the equivalent of a presigned GET). */
export const GET = withErrorHandling(async (request) => {
  const { storage, payload } = verify(request, "get");
  if (payload.op !== "get") throw new ForbiddenError();
  const data = await storage.readForDownload(payload.key as StorageKey);
  if (!data) throw new NotFoundError("The file no longer exists.");

  const ascii = payload.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new NextResponse(new Blob([new Uint8Array(data)]), {
    status: 200,
    headers: {
      "Content-Type": payload.contentType,
      "Content-Length": String(data.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
