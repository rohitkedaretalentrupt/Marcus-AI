import "server-only";

/**
 * Bounds how many heavy background tasks (document parsing, template
 * analysis, formatting) run at once in this process, so a burst of requests
 * cannot exhaust CPU/memory or flood the AI provider. Extra tasks wait in
 * FIFO order. Per-process only — the app runs as a single instance.
 */
export function createWorkLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < maxConcurrent) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

export const MAX_CONCURRENT_BACKGROUND_TASKS = 3;

/** Shared by resume extraction, template analysis and formatting jobs. */
export const backgroundWork = createWorkLimiter(MAX_CONCURRENT_BACKGROUND_TASKS);
