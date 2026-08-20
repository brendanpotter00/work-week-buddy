/**
 * The complaint that arrives the moment a freeze ends.
 *
 * Nothing can log DURING a blocked main thread — logging is code, and code does
 * not run. What this can do is notice the gap afterwards and name it, so a
 * freeze that resolves stops being "it felt slow" and becomes a line with a
 * number and the step it happened on.
 *
 * Driven by an injected clock rather than a real one: a test that proves a
 * timing rule by waiting is a test that fails on a loaded CI box.
 */
import { describe, expect, it, vi } from "vitest";

import { STALL_MS, watchMainThread } from "./stall";

/** A hand-cranked interval: one `tick()` per timer fire, on a clock we own. */
function harness(stallMs?: number) {
  let nowMs = 1_000;
  const fires: Array<() => void> = [];
  const stalls: Array<{ ms: number; during: string }> = [];
  const watch = watchMainThread({
    tickMs: 1_000,
    ...(stallMs === undefined ? {} : { stallMs }),
    now: () => nowMs,
    setRepeating: (fn) => {
      fires.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    },
    clearRepeating: () => undefined,
    onStall: (ms, during) => stalls.push({ ms, during }),
  });
  return {
    watch,
    stalls,
    /** Advance the clock by `ms`, then let the timer fire once. */
    advance(ms: number): void {
      nowMs += ms;
      for (const fire of fires) fire();
    },
  };
}

describe("the main-thread stall watch", () => {
  it("says nothing while the loop is being served on time", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.advance(1_000);
    expect(h.stalls).toEqual([]);
  });

  it("ignores an ordinary hiccup — a GC pause is not a freeze", () => {
    const h = harness();
    h.advance(1_200); // 200ms late
    expect(h.stalls).toEqual([]);
  });

  it("complains once the gap is a freeze, with the duration", () => {
    const h = harness();
    // Nine seconds where nothing else in the app ran.
    h.advance(10_000);
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0]?.ms).toBe(9_000);
  });

  it("names the step it was on, which is the first question anybody asks", () => {
    const h = harness();
    h.watch.mark("reading the sync token from the keychain");
    h.advance(30_000);
    expect(h.stalls[0]?.during).toBe("reading the sync token from the keychain");
  });

  it("re-baselines at a step boundary, so a stall lands on the step that caused it", () => {
    const h = harness();
    h.advance(1_000);
    // `mark()` resets the clock reference: the time spent in the PREVIOUS step
    // must not be charged to the next one.
    h.watch.mark("running");
    h.advance(1_000);
    expect(h.stalls).toEqual([]);
  });

  it("remembers the worst gap for the smoke run to assert on", () => {
    const h = harness();
    h.advance(4_000);
    h.advance(1_000);
    h.advance(2_500);
    expect(h.watch.worstMs()).toBe(3_000);
  });

  it("draws the line where a human would notice", () => {
    // Below this a gap is a slow frame. Above it the app was gone.
    expect(STALL_MS).toBeGreaterThanOrEqual(1_000);
    expect(STALL_MS).toBeLessThanOrEqual(5_000);
  });

  it("stops cleanly", () => {
    const cleared: number[] = [];
    const watch = watchMainThread({
      setRepeating: () => 7 as unknown as NodeJS.Timeout,
      clearRepeating: (t) => cleared.push(t as unknown as number),
      onStall: () => undefined,
    });
    watch.stop();
    expect(cleared).toEqual([7]);
  });

  it("logs loudly by default — the whole point is that somebody reads it", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      let nowMs = 0;
      const fires: Array<() => void> = [];
      watchMainThread({
        tickMs: 1_000,
        now: () => nowMs,
        setRepeating: (fn) => {
          fires.push(fn);
          return 0 as unknown as NodeJS.Timeout;
        },
        clearRepeating: () => undefined,
      });
      nowMs += 20_000;
      for (const fire of fires) fire();
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/main thread was blocked for 19000ms/);
  });
});
