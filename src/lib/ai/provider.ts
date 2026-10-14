import "server-only";

import { getServerEnv } from "@/lib/config/env.server";
import type { AIConfig } from "@/lib/config/server-env-schema";
import { ServiceUnavailableError } from "@/lib/errors/app-error";

import { createMimoProvider } from "./providers/mimo/mimo-provider";
import type { AIProvider } from "./types";

function createAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case "mimo":
      return createMimoProvider(config);
  }
}

let cachedProvider: AIProvider | undefined;

/** True when an AI provider is configured (safe to call from server components). */
export function isAIEnabled(): boolean {
  return getServerEnv().ai !== null;
}

/** Returns the configured AI provider. Server-only; never import from client code. */
export function getAIProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;

  const { ai } = getServerEnv();
  if (!ai) {
    throw new ServiceUnavailableError(
      "AI responses aren't available right now.",
      "AI provider is not configured (set AI_PROVIDER and AI_API_KEY).",
    );
  }

  cachedProvider = createAIProvider(ai);
  return cachedProvider;
}
