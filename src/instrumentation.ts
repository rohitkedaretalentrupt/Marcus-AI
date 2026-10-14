/**
 * Next.js calls `register` once when the server starts (not during `next
 * build`). Server-only startup work lives in src/server/startup.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./server/startup");
  await runStartupChecks();
}
