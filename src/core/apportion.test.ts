import { describe, expect, it } from "vitest";

import { apportion } from "./apportion";

const total = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe("apportion", () => {
  it("sums to the total exactly, which is the only reason it exists", () => {
    // The case naive rounding gets wrong: 2.505 h each. Rounded on their own
    // they come to 5.00 while the day comes to 5.01, and the stack ends up a
    // hundredth of an hour shorter than the bar it is drawn inside.
    const parts = apportion([9018000, 9018000], 501);
    expect(total(parts)).toBe(501);
    expect(parts).toEqual([251, 250]);
  });

  it("is proportional when it can be", () => {
    expect(apportion([2, 1], 300)).toEqual([200, 100]);
    expect(apportion([1, 1, 1, 1], 800)).toEqual([200, 200, 200, 200]);
  });

  it("gives the remainder to whoever lost the most to the floor", () => {
    // 100 across 3 → 33.33 each; the two units go to the first two, by index,
    // because all three fractions tie.
    expect(apportion([1, 1, 1], 100)).toEqual([34, 33, 33]);
    // 7/10 and 3/10 of 101 → 70.7 and 30.3. The 0.7 wins the spare unit.
    expect(apportion([7, 3], 101)).toEqual([71, 30]);
  });

  it("is deterministic — the same input never reshuffles", () => {
    const a = apportion([5, 5, 5], 100);
    const b = apportion([5, 5, 5], 100);
    expect(a).toEqual(b);
    expect(total(a)).toBe(100);
  });

  it("credits a zero weight zero, and does not steal from it", () => {
    expect(apportion([0, 4], 400)).toEqual([0, 400]);
    expect(apportion([3, 0, 1], 100)).toEqual([75, 0, 25]);
  });

  it("holds for every total over a lopsided three-way split", () => {
    for (let t = 0; t <= 2400; t++) {
      const parts = apportion([13, 5, 1], t);
      expect(total(parts)).toBe(t);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });

  it("hands a total with nothing to weigh it by to the first part", () => {
    // Not reachable from `buildWeekBars` — hours imply countable rows imply a
    // machine — but a total that quietly evaporated would be a stack shorter
    // than its bar, which is the exact failure this file prevents.
    expect(apportion([0, 0], 120)).toEqual([120, 0]);
    expect(apportion([0, 0], 0)).toEqual([0, 0]);
  });

  it("has nothing to say about no parts at all", () => {
    expect(apportion([], 0)).toEqual([]);
    expect(apportion([], 500)).toEqual([]);
  });

  it("ignores a weight that is not a usable number", () => {
    expect(total(apportion([Number.NaN, 2, -3], 100))).toBe(100);
    expect(apportion([Number.NaN, 2, -3], 100)).toEqual([0, 100, 0]);
  });
});
