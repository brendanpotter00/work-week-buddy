import { describe, it, expect, vi } from "vitest";
import { createDeadline, MAX_DELAY_MS } from "./deadline";

/**
 * A fake timer wheel. The scheduler must never be tested against a real clock:
 * the whole point of it is what happens when four hours pass between arming and
 * firing, and a test that waits four hours is not a test.
 */
function wheel(startMs = 1_700_000_000_000) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  const scheduled: number[] = [];

  return {
    now: () => now,
    /** Every delay ever passed to schedule(), in order. */
    scheduled,
    get pending() {
      return timers.size;
    },
    schedule(fn: () => void, ms: number): NodeJS.Timeout {
      const id = nextId++;
      scheduled.push(ms);
      timers.set(id, { fireAt: now + ms, fn });
      return id as unknown as NodeJS.Timeout;
    },
    unschedule(t: NodeJS.Timeout): void {
      timers.delete(t as unknown as number);
    },
    /** Advance the clock and run anything that came due. */
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.fireAt <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    /** Jump the clock WITHOUT running timers — the machine was asleep. */
    sleep(ms: number) {
      now += ms;
    },
    /** Run everything that is due, having already jumped the clock. */
    settle() {
      for (const [id, timer] of [...timers]) {
        if (timer.fireAt <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("the lazy countdown", () => {
  it("arms for an absolute instant and reports what it is armed for", () => {
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    expect(d.armedFor).toBeNull();
    d.arm(T0 + 15 * MIN);
    expect(d.armedFor).toBe(T0 + 15 * MIN);
    expect(w.scheduled).toEqual([15 * MIN]);
  });

  it("fires with the real wall-clock time, not the instant it was armed for", () => {
    // This is what makes sleep self-healing with no sleep-specific code. The
    // reducer compares the fire time against lastRealSignalMs and closes at the
    // pre-sleep signal.
    const w = wheel();
    const fire = vi.fn();
    const d = createDeadline(fire, w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    w.sleep(3 * 60 * MIN); // lid shut for three hours
    w.settle();
    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith(T0 + 180 * MIN);
    expect(fire.mock.calls[0]![0]).not.toBe(T0 + 15 * MIN);
  });

  it("is lazy: re-arming for a later instant leaves the pending timer alone", () => {
    // A 300-events-per-second mouse drag must cost zero timer syscalls.
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    for (let i = 1; i <= 300; i++) d.arm(T0 + 15 * MIN + i);
    expect(w.scheduled).toHaveLength(1);
    expect(d.armedFor).toBe(T0 + 15 * MIN);
  });

  it("is lazy: re-arming for the same instant is a no-op", () => {
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    d.arm(T0 + 15 * MIN);
    expect(w.scheduled).toHaveLength(1);
    expect(w.pending).toBe(1);
  });

  it("re-arms for an EARLIER instant, replacing the pending timer", () => {
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    d.arm(T0 + 5 * MIN);
    expect(w.scheduled).toEqual([15 * MIN, 5 * MIN]);
    expect(w.pending).toBe(1);
    expect(d.armedFor).toBe(T0 + 5 * MIN);
  });

  it("cancel() clears the timer and the armed instant", () => {
    const w = wheel();
    const fire = vi.fn();
    const d = createDeadline(fire, w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    d.cancel();
    expect(d.armedFor).toBeNull();
    expect(w.pending).toBe(0);
    w.advance(60 * MIN);
    expect(fire).not.toHaveBeenCalled();
  });

  it("cancel() with nothing armed is harmless", () => {
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    d.cancel();
    d.cancel();
    expect(d.armedFor).toBeNull();
    expect(w.pending).toBe(0);
  });

  it("arms again after firing, because firing clears the armed instant", () => {
    const w = wheel();
    const fire = vi.fn();
    const d = createDeadline(fire, w.now, w.schedule, w.unschedule);
    d.arm(T0 + 15 * MIN);
    w.advance(15 * MIN);
    expect(fire).toHaveBeenCalledOnce();
    expect(d.armedFor).toBeNull();
    d.arm(w.now() + 15 * MIN);
    expect(d.armedFor).toBe(T0 + 30 * MIN);
    expect(w.scheduled).toEqual([15 * MIN, 15 * MIN]);
  });

  it("clamps a deadline in the past to a zero delay rather than a negative one", () => {
    const w = wheel();
    const fire = vi.fn();
    const d = createDeadline(fire, w.now, w.schedule, w.unschedule);
    d.arm(T0 - 4 * 60 * MIN); // four hours in the past
    expect(w.scheduled).toEqual([0]);
    w.advance(0);
    expect(fire).toHaveBeenCalledWith(T0);
  });

  it("clamps a far-future deadline to six hours so a stale timer is re-evaluated", () => {
    // A delay over ~24.8 days overflows and fires immediately, forever.
    const w = wheel();
    const d = createDeadline(vi.fn(), w.now, w.schedule, w.unschedule);
    d.arm(T0 + 30 * 24 * 60 * MIN);
    expect(w.scheduled).toEqual([MAX_DELAY_MS]);
    expect(d.armedFor).toBe(T0 + 30 * 24 * 60 * MIN);
  });

  it("a clamped timer fires early, which is free — the reducer re-arms", () => {
    const w = wheel();
    const fire = vi.fn();
    const d = createDeadline(fire, w.now, w.schedule, w.unschedule);
    d.arm(T0 + 30 * 24 * 60 * MIN);
    w.advance(MAX_DELAY_MS);
    expect(fire).toHaveBeenCalledWith(T0 + MAX_DELAY_MS);
    expect(d.armedFor).toBeNull();
  });

  it("defaults to the real clock and real timers", async () => {
    // The production wiring passes nothing. Prove the defaults are real, then
    // keep the test under a millisecond by arming for the past.
    const fire = vi.fn();
    const d = createDeadline(fire);
    d.arm(Date.now() - 1000);
    expect(d.armedFor).toBeLessThan(Date.now() + 1);
    // Wait for the callback rather than for a fixed 5ms. The armed delay
    // clamps to 0, so idle this always won — but under load (a concurrent
    // npm install, say) a fixed sleep is a coin flip, and a flaky test in a
    // suite meant to gate merges is worse than a failing one.
    await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
    expect(d.armedFor).toBeNull();

    // And that cancel() reaches the real clearTimeout.
    const d2 = createDeadline(fire);
    d2.arm(Date.now() + 60_000);
    d2.cancel();
    expect(d2.armedFor).toBeNull();
  });
});
