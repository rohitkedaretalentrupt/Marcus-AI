import { describe, expect, it } from "vitest";

import { aiFillPlanSchema } from "./fill-plan";

const refsOf = (refs: (string | null)[]) =>
  aiFillPlanSchema.safeParse({ version: 1, fills: [{ block: "p1", refs }] });

describe("fill plan references", () => {
  it("accepts contact fields joined on one line", () => {
    const parsed = refsOf(["contact.email+contact.phone"]);
    expect(parsed.success && parsed.data.fills[0]!.refs).toEqual(["contact.email+contact.phone"]);
  });

  it("drops separators typed in as text, spaces and stray '+'", () => {
    const parsed = refsOf([
      's2.e0.heading+" - "+s2.e0.subheading+',
      "s2.e0.startDate + ' – ' + s2.e0.endDate",
    ]);
    expect(parsed.success && parsed.data.fills[0]!.refs).toEqual([
      "s2.e0.heading+s2.e0.subheading",
      "s2.e0.startDate+s2.e0.endDate",
    ]);
  });

  it("still rejects unknown references and mixed contact/entry joins", () => {
    expect(refsOf(["s2.e0.salary"]).success).toBe(false);
    expect(refsOf(["contact.email+s0.e0.heading"]).success).toBe(false);
    expect(refsOf(["contactXemail"]).success).toBe(false);
  });
});
