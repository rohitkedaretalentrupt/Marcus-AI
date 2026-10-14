import { describe, expect, it } from "vitest";

import { buildStorageKey, isKeyOwnedBy } from "./keys";

describe("buildStorageKey", () => {
  it("builds a tenant-scoped key from server-generated ids", () => {
    const key = buildStorageKey({
      userId: "user123",
      category: "uploads",
      objectId: "file456",
      extension: "PDF",
    });

    expect(key).toBe("users/user123/uploads/file456.pdf");
    expect(isKeyOwnedBy(key, "user123")).toBe(true);
    expect(isKeyOwnedBy(key, "user12")).toBe(false);
  });

  it.each([
    { userId: "../other", objectId: "file", extension: "pdf" },
    { userId: "user", objectId: "a/b", extension: "pdf" },
    { userId: "user", objectId: "file", extension: "p df" },
  ])("rejects unsafe segments %o", (params) => {
    expect(() => buildStorageKey({ ...params, category: "uploads" })).toThrow();
  });
});
