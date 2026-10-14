import "server-only";

import { getServerEnv } from "@/lib/config/env.server";
import type { StorageConfig } from "@/lib/config/server-env-schema";
import { ServiceUnavailableError } from "@/lib/errors/app-error";

import { createR2StorageProvider } from "./providers/cloudflare-r2/r2-storage-provider";
import {
  createLocalStorageProvider,
  type LocalStorageProvider,
} from "./providers/local/local-storage-provider";
import type { StorageProvider } from "./types";

function createStorageProvider(config: StorageConfig): StorageProvider {
  switch (config.provider) {
    case "r2":
      return createR2StorageProvider(config);
    case "local":
      return createLocalStorageProvider(config);
  }
}

let cachedProvider: StorageProvider | undefined;

/** True when object storage is configured (safe to call from server components). */
export function isStorageEnabled(): boolean {
  return getServerEnv().storage !== null;
}

/** The configured storage provider. Server-only; never import from client code. */
export function getStorageProvider(): StorageProvider {
  if (cachedProvider) return cachedProvider;

  const { storage } = getServerEnv();
  if (!storage) {
    throw new ServiceUnavailableError(
      "File uploads aren't available right now.",
      "Storage is not configured (set STORAGE_PROVIDER=r2 and the R2_* variables, or STORAGE_PROVIDER=local in development).",
    );
  }

  cachedProvider = createStorageProvider(storage);
  return cachedProvider;
}

/** The local development storage, or null when another provider (or none) is configured. */
export function getLocalStorageProvider(): LocalStorageProvider | null {
  const { storage } = getServerEnv();
  if (storage?.provider !== "local") return null;
  return getStorageProvider() as LocalStorageProvider;
}
