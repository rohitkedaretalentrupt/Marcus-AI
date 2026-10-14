import "server-only";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

function serializeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

/**
 * Minimal structured (JSON-lines) logger: readable in `docker logs` and easy
 * to ship to a log service later. Swap the implementation here, not at call sites.
 * Never pass secrets or raw resume content as context.
 */
function write(level: LogLevel, message: string, context?: LogContext) {
  const entry = JSON.stringify({ level, time: new Date().toISOString(), message, ...context });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, context?: LogContext) => {
    if (process.env.NODE_ENV !== "production") write("debug", message, context);
  },
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, error?: unknown, context?: LogContext) =>
    write("error", message, { ...context, error: error ? serializeError(error) : undefined }),
};
