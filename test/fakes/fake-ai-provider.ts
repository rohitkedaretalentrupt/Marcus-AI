import type { AIProvider } from "@/lib/ai/types";

const unused = async (): Promise<never> => {
  throw new Error("Not used in this test");
};

/** TEST DOUBLE ONLY — a mocked AI provider; no model is ever called. */
export function createFakeAIProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: "mimo",
    modelName: "fake-model",
    executeResumeTask: unused,
    streamResumeTask: async function* () {
      throw new Error("Not used in this test");
    },
    classifyChatIntent: unused,
    analyzeTemplate: unused,
    analyzeResume: unused,
    formatResume: unused,
    fillTemplate: unused,
    ...overrides,
  };
}
