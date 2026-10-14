import { describe, expect, it } from "vitest";

import { createWorkLimiter } from "./work-limiter";

describe("createWorkLimiter", () => {
  it("never runs more than the limit at once and runs everything in order", async () => {
    const limiter = createWorkLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      running--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limiter.run(task(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
    expect(limiter.active).toBe(0);
  });

  it("releases the slot when a task fails", async () => {
    const limiter = createWorkLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
    expect(limiter.active).toBe(0);
  });
});
