/**
 * The watchdog reads and does not write.
 *
 * The tempting implementation — "post a null canary and see whether the tap
 * sees it" — is fatal: a posted event resets the system idle clock, so a
 * watchdog that posts every five minutes is an always-on mouse jiggler that
 * nobody asked for. These tests exist to make that regression impossible to
 * land quietly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSignalSource } from "../native";
import type { NativeStatus } from "../native";
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

describe("the watchdog posts nothing", () => {
  it("touches only probe() across a hundred ticks", () => {
    const source = new FakeSignalSource();
    const { proxy, touched } = spyOnSource(source);
    const ticks: NativeStatus[] = [];

    const wd = createWatchdog({
      source: proxy,
      target: {
        onWatchdogTick: (s) => ticks.push(s),
        onTapLost: () => {
          throw new Error("the tap was alive; onTapLost must not fire");
        },
      },
    });

    for (let i = 0; i < 100; i++) wd.tick();

    expect(ticks).toHaveLength(100);
    expect(new Set(touched)).toEqual(new Set(["probe"]));
    for (const m of EVENT_POSTING_METHODS) expect(touched).not.toContain(m);
    // The observable proof, independent of how the spy is wired: nothing was posted.
    expect(source.jiggles).toHaveLength(0);
    expect(source.keepAwake).toBe(false);
  });

  it("posts nothing even when it has to rebuild a dead tap", () => {
    const source = new FakeSignalSource();
    void source.start(() => {});
    source.killTap();
    const { proxy, touched } = spyOnSource(source);
    const lost: number[] = [];

    const wd = createWatchdog({
      source: proxy,
      now: () => T0,
      target: { onWatchdogTick: () => {}, onTapLost: (at) => lost.push(at) },
    });

    wd.tick();

    expect(lost).toEqual([T0]);
    expect(wd.tapRestarts).toBe(1);
    expect(new Set(touched)).toEqual(new Set(["probe", "restart"]));
    for (const m of EVENT_POSTING_METHODS) expect(touched).not.toContain(m);
    // Rebuilding OUR OWN tap is not an event post.
    expect(source.jiggles).toHaveLength(0);
  });

  it("its type cannot reach an event-posting function", () => {
    // A `WatchdogSource` is `{ probe, restart }` and nothing else, so widening
    // it is a visible change to a type rather than one extra line in a tick.
    const minimal = {
      probe: () => new FakeSignalSource().probe(),
      restart: () => new FakeSignalSource().probe(),
    };
    const wd = createWatchdog({
      source: minimal,
      target: { onWatchdogTick: () => {}, onTapLost: () => {} },
    });
    expect(() => wd.tick()).not.toThrow();
  });
});

describe("the watchdog's timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("ticks every five minutes and stops cleanly", () => {
    const source = new FakeSignalSource();
    const wd = createWatchdog({
      source,
      target: { onWatchdogTick: () => {}, onTapLost: () => {} },
    });
    wd.start();
    wd.start(); // idempotent: two timers would double every read
    vi.advanceTimersByTime(DEFAULTS.watchdogMs * 3);
    expect(wd.ticks).toBe(3);
    wd.stop();
    vi.advanceTimersByTime(DEFAULTS.watchdogMs * 3);
    expect(wd.ticks).toBe(3);
    expect(source.jiggles).toHaveLength(0);
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

  it("a dead tap closes the interval at the last signal, not at the tick", async () => {
    h = await makeHarness();
    const wd = createWatchdog({ source: h.source, target: h.runtime });
    wd.start();

    h.source.key(Date.now());
    vi.advanceTimersByTime(2 * MIN);
    h.source.key(Date.now());
    const lastSignal = Date.now();

    h.source.killTap();
    vi.advanceTimersByTime(DEFAULTS.watchdogMs);

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.end_reason).toBe("tap_lost");
    expect(stored[0]!.ended_at_ms).toBe(lastSignal);
    // The tap was rebuilt, and still nothing was posted.
    expect(h.source.restarts).toBe(1);
    expect(h.source.jiggles).toHaveLength(0);
    wd.stop();
  });
});
