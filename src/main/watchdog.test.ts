/**
 * The watchdog reads and does not write.
 *
 * The tempting implementation — "post a null canary and see whether the tap
 * sees it" — is fatal: a posted event resets the system idle clock, so a
 * watchdog that posts every five minutes is an always-on mouse jiggler that
 * nobody asked for. These tests exist to make that regression impossible to
 * land quietly.
 *
 * The second half of the file is about the bug that made the app measure
 * nothing: a tap macOS had switched off, noticed only every five minutes, and
 * then "recovered" by closing the owner's session. Two seconds of blindness is
 * a hiccup; five minutes of it is the working day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSignalSource } from "../native";
import type { NativeStatus, TapRevival } from "../native";
import { createWatchdog } from "./watchdog";
import { MIN, T0, makeHarness, rows, type Harness } from "../../test/helpers/runtime";
import { DEFAULTS } from "../shared/constants";

/** Every method name the watchdog reached for, in order. */
function spyOnSource(source: FakeSignalSource): {
  proxy: FakeSignalSource;
  touched: string[];
} {
  const touched: string[] = [];
  const proxy = new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === "string") touched.push(prop);
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { proxy, touched };
}

/**
 * The full list of things on `SignalSource` that cause a side effect outside
 * this process. NOT ONE of these may be reachable from a watchdog tick.
 */
const EVENT_POSTING_METHODS = ["jiggle", "setKeepAwake", "start", "stop", "requestPermissions"];

const silentTarget = {
  onWatchdogTick: (): void => {},
  onTapLost: (): void => {},
  onTapRevived: (): void => {},
};

describe("the watchdog posts nothing", () => {
  it("reads only tapAlive() and probe() across a hundred beats", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    const { proxy, touched } = spyOnSource(source);
    const ticks: NativeStatus[] = [];
    let clock = T0;

    const wd = createWatchdog({
      source: proxy,
      now: () => clock,
      target: {
        ...silentTarget,
        onWatchdogTick: (s) => ticks.push(s),
        onTapLost: () => {
          throw new Error("the tap was alive; onTapLost must not fire");
        },
      },
    });

    for (let i = 0; i < 100; i++) {
      wd.tick();
      clock += DEFAULTS.tapLivenessMs;
    }

    expect(wd.ticks).toBe(100);
    expect(new Set(touched)).toEqual(new Set(["tapAlive", "probe"]));
    for (const m of EVENT_POSTING_METHODS) expect(touched).not.toContain(m);
    // The observable proof, independent of how the spy is wired: nothing was posted.
    expect(source.jiggles).toHaveLength(0);
    expect(source.keepAwake).toBe(false);
  });

  it("does the EXPENSIVE probe on the slow cadence, not on every beat", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    let clock = T0;
    const wd = createWatchdog({
      source,
      now: () => clock,
      target: silentTarget,
    });

    // Five minutes of two-second beats.
    for (let i = 0; i < DEFAULTS.watchdogMs / DEFAULTS.tapLivenessMs; i++) {
      wd.tick();
      clock += DEFAULTS.tapLivenessMs;
    }

    expect(wd.ticks).toBe(150);
    // The camera/mic/HAL walk is the reason the slow cadence exists: it must
    // not be dragged up to 150x by making the tap check frequent.
    expect(wd.fullProbes).toBe(1);
  });

  it("posts nothing even when it has to rebuild a dead tap", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    source.killTap();
    source.reviveRefusesEnable = true;
    const { proxy, touched } = spyOnSource(source);
    const revived: TapRevival[] = [];

    const wd = createWatchdog({
      source: proxy,
      now: () => T0,
      target: { ...silentTarget, onTapRevived: (_at, r) => revived.push(r) },
    });

    wd.tick();

    expect(revived.map((r) => r.outcome)).toEqual(["rebuilt"]);
    expect(wd.tapRebuilds).toBe(1);
    for (const m of EVENT_POSTING_METHODS) expect(touched).not.toContain(m);
    // Rebuilding OUR OWN tap is not an event post.
    expect(source.jiggles).toHaveLength(0);
  });

  it("its type cannot reach an event-posting function", () => {
    // A `WatchdogSource` is `{ probe, tapAlive, reviveTap }` and nothing else,
    // so widening it is a visible change to a type rather than one extra line
    // in a tick.
    const minimal = {
      probe: () => new FakeSignalSource().probe(),
      tapAlive: () => true,
      reviveTap: (): TapRevival => ({ outcome: "healthy", detail: "" }),
    };
    const wd = createWatchdog({ source: minimal, target: silentTarget });
    expect(() => wd.tick()).not.toThrow();
  });
});

describe("a tap macOS switched off comes back on its own", () => {
  /**
   * THE BUG THIS FILE EXISTS FOR.
   *
   * macOS disables an event tap whose callback is slow, and it does NOT
   * announce it: measured, the disable notice waits for the next event, which
   * is the very thing the app has just gone blind to. Before this, the only
   * thing that noticed was a five-minute probe — so every time the machine
   * knocked the tap over, the owner lost up to five minutes of work AND had
   * his open session closed and filed as `tap_lost`. His database is a row of
   * two-to-six-minute fragments because of it.
   */
  it("is revived within one beat, with nothing focused and nobody touching the app", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    let clock = T0;
    const revived: Array<{ at: number; outcome: string }> = [];
    const wd = createWatchdog({
      source,
      now: () => clock,
      target: {
        ...silentTarget,
        onTapLost: () => {
          throw new Error("a recoverable tap is not a tap loss");
        },
        onTapRevived: (at, r) => revived.push({ at, outcome: r.outcome }),
      },
    });

    source.killTap();
    expect(source.tapAlive()).toBe(false);

    clock += DEFAULTS.tapLivenessMs;
    wd.tick();

    expect(source.tapAlive()).toBe(true);
    expect(revived).toEqual([{ at: T0 + DEFAULTS.tapLivenessMs, outcome: "reenabled" }]);
    expect(wd.tapRevivals).toBe(1);
    expect(wd.tapLosses).toBe(0);
  });

  it("recovers from kCGEventTapDisabledByUserInput exactly as from ByTimeout", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    const wd = createWatchdog({ source, now: () => T0, target: silentTarget });

    source.killTap("userInput");
    wd.tick();

    expect(source.tapAlive()).toBe(true);
    expect(source.probe().counters.disableNoticesByUserInput).toBe(1);
    expect(wd.tapRevivals).toBe(1);
  });

  it("rebuilds the tap when a plain re-enable is refused", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    source.reviveRefusesEnable = true;
    const wd = createWatchdog({ source, now: () => T0, target: silentTarget });

    source.killTap();
    wd.tick();

    expect(source.tapAlive()).toBe(true);
    expect(wd.tapRebuilds).toBe(1);
    expect(source.restarts).toBe(1);
  });

  it("reports an unrecoverable tap ONCE, not once per beat", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    source.tapUnrecoverable = true;
    let clock = T0;
    const lost: number[] = [];
    const wd = createWatchdog({
      source,
      now: () => clock,
      target: { ...silentTarget, onTapLost: (at) => lost.push(at) },
    });

    source.killTap();
    for (let i = 0; i < 50; i++) {
      wd.tick();
      clock += DEFAULTS.tapLivenessMs;
    }

    // Fifty beats of a dead tap is one outage, not fifty `tap_lost` rows.
    expect(lost).toEqual([T0]);
    expect(wd.tapLosses).toBe(1);
    expect(wd.tapDown).toBe(true);

    // ...and when the machine relents, it says so and starts watching again.
    source.tapUnrecoverable = false;
    clock += DEFAULTS.tapLivenessMs;
    wd.tick();
    expect(wd.tapDown).toBe(false);
    expect(source.tapAlive()).toBe(true);
  });

  it("a source that throws does not take the watchdog down with it", () => {
    let clock = T0;
    let boom = true;
    const lost: number[] = [];
    const wd = createWatchdog({
      source: {
        probe: () => new FakeSignalSource().probe(),
        tapAlive: () => {
          if (boom) throw new Error("koffi exploded");
          return true;
        },
        reviveTap: (): TapRevival => {
          throw new Error("and so did the rebuild");
        },
      },
      now: () => clock,
      target: { ...silentTarget, onTapLost: (at) => lost.push(at) },
    });

    // A throw out of the timer callback would leave the app with no watchdog at
    // all, which turns a recoverable tap into a permanently dead one.
    expect(() => wd.tick()).not.toThrow();
    expect(lost).toEqual([T0]);

    boom = false;
    clock += DEFAULTS.tapLivenessMs;
    expect(() => wd.tick()).not.toThrow();
    expect(wd.tapDown).toBe(false);
  });
});

describe("the watchdog's timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("beats on the liveness cadence and stops cleanly", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    const wd = createWatchdog({ source, target: silentTarget });
    wd.start();
    wd.start(); // idempotent: two timers would double every read
    vi.advanceTimersByTime(DEFAULTS.tapLivenessMs * 3);
    expect(wd.ticks).toBe(3);
    wd.stop();
    vi.advanceTimersByTime(DEFAULTS.tapLivenessMs * 3);
    expect(wd.ticks).toBe(3);
    expect(source.jiggles).toHaveLength(0);
  });

  it("still reaches the full probe on the five-minute cadence", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    const wd = createWatchdog({ source, target: silentTarget });
    wd.start();
    vi.advanceTimersByTime(DEFAULTS.watchdogMs * 3);
    expect(wd.fullProbes).toBe(3);
    wd.stop();
  });
});

describe("the watchdog wired to the runtime", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    h?.close();
    vi.useRealTimers();
  });

  it("re-reads the granted mask, so a revocation is loud within one tick", async () => {
    h = await makeHarness();
    const wd = createWatchdog({ source: h.source, target: h.runtime });
    wd.start();

    expect(h.runtime.liveStatus().degraded).toEqual([]);
    h.source.stripKeyboardBits();
    vi.advanceTimersByTime(DEFAULTS.watchdogMs);

    expect(h.runtime.liveStatus().degraded).toContain("keyboard_permission_missing");
    expect(h.source.jiggles).toHaveLength(0);
    wd.stop();
  });

  it("KEEPS the session open when macOS knocks the tap over and it comes back", async () => {
    h = await makeHarness();
    const wd = createWatchdog({ source: h.source, target: h.runtime });
    wd.start();

    h.source.key(Date.now());
    vi.advanceTimersByTime(2 * MIN);
    h.source.key(Date.now());

    // macOS disables the tap. Nobody focuses anything; nobody clicks anything.
    h.source.killTap();
    vi.advanceTimersByTime(DEFAULTS.tapLivenessMs * 2);

    expect(h.source.tapAlive()).toBe(true);
    // Nothing was filed. The owner was working; two seconds of blindness is not
    // a reason to end his session and call it `tap_lost`.
    expect(rows(h.db)).toHaveLength(0);
    expect(h.runtime.liveStatus().state).toBe("working");
    expect(h.runtime.liveStatus().degraded).not.toContain("tap_lost");

    // And the interval keeps growing afterwards, from input alone.
    const resumed = Date.now();
    h.source.key(resumed);
    expect(h.runtime.liveStatus().lastSignalMs).toBe(resumed);
    wd.stop();
  });

  it("a tap that will NOT come back still closes at the last signal, not at the tick", async () => {
    h = await makeHarness();
    const wd = createWatchdog({ source: h.source, target: h.runtime });
    wd.start();

    h.source.key(Date.now());
    vi.advanceTimersByTime(2 * MIN);
    h.source.key(Date.now());
    const lastSignal = Date.now();

    h.source.tapUnrecoverable = true;
    h.source.killTap();
    vi.advanceTimersByTime(DEFAULTS.tapLivenessMs * 4);

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.end_reason).toBe("tap_lost");
    // AGENTS.md's rule that outranks everything: never `now()`.
    expect(stored[0]!.ended_at_ms).toBe(lastSignal);
    // One row for one outage, however many beats it spans.
    expect(wd.tapLosses).toBe(1);
    expect(h.source.jiggles).toHaveLength(0);
    wd.stop();
  });
});
