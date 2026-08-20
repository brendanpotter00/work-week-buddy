/**
 * Lifecycle wiring: the handlers that decide what closes an interval.
 *
 * Each row of the power table is a decision that goes wrong quietly — "sleep
 * closes the interval" costs nothing visible and silently deletes every
 * evening's tail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PowerMonitor } from "electron";

import {
  onWindowAllClosed,
  policyFromSettings,
  wirePowerMonitor,
  wireQuit,
  wireWindowLifecycle,
  withTimeout,
} from "./bootstrap";
import { parsePlatformUuid } from "./machine-id";
import { MIN, T0, fakeSettings, makeHarness, rows, type Harness } from "../../test/helpers/runtime";
import { countIntervals } from "../store";
import type { SettingsStore } from "./settings";

class Emitter {
  readonly handlers = new Map<string, Array<(...a: never[]) => void>>();
  on(event: string, cb: (...a: never[]) => void): this {
    const l = this.handlers.get(event) ?? [];
    l.push(cb);
    this.handlers.set(event, l);
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  h?.close();
  vi.useRealTimers();
});

describe("window lifecycle", () => {
  it("window-all-closed does nothing at all", () => {
    // If this ever calls app.quit(), closing the dashboard ends the working day.
    expect(onWindowAllClosed()).toBeUndefined();
  });

  it("re-opens the dashboard on activate only when no window exists", () => {
    const app = new Emitter();
    let shown = 0;
    let windows = 1;
    wireWindowLifecycle({
      app: app as unknown as Pick<App, "on">,
      hasWindows: () => windows > 0,
      showDashboard: () => shown++,
    });
    app.fire("activate");
    expect(shown).toBe(0);
    windows = 0;
    app.fire("activate");
    expect(shown).toBe(1);
  });
});

describe("power events", () => {
  it("UI-T06: suspend closes nothing; resume past the deadline closes at the pre-sleep signal", async () => {
    h = await makeHarness();
    const pm = new Emitter();
    wirePowerMonitor({
      powerMonitor: pm as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: null,
    });

    h.source.key(Date.now());
    vi.advanceTimersByTime(MIN);
    h.source.key(Date.now());
    const lastSignal = Date.now();

    pm.fire("suspend");
    await vi.advanceTimersByTimeAsync(0);
    expect(countIntervals(h.db)).toBe(0);

    vi.advanceTimersByTime(3 * 60 * MIN);
    pm.fire("resume");
    await vi.advanceTimersByTimeAsync(0);

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    // Not wake time. The whole night is not work.
    expect(stored[0]!.ended_at_ms).toBe(lastSignal);
  });

  it("UI-T07: resume re-evaluates the deadline BEFORE flushing", async () => {
    h = await makeHarness();
    const order: string[] = [];
    const realResume = h.runtime.onResume.bind(h.runtime);
    h.runtime.onResume = async (a, b) => {
      order.push("onResume");
      await realResume(a, b);
    };
    const realFlush = h.runtime.flushNow.bind(h.runtime);
    h.runtime.flushNow = async () => {
      order.push("flush");
      return realFlush();
    };

    const pm = new Emitter();
    const trayRefreshes: string[] = [];
    wirePowerMonitor({
      powerMonitor: pm as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: { refresh: (r) => trayRefreshes.push(r) },
    });

    pm.fire("resume");
    await vi.advanceTimersByTimeAsync(0);
    // The closed row must already be in the outbox when the first flush runs.
    expect(order).toEqual(["onResume", "flush"]);
    expect(trayRefreshes).toContain("resume");
  });

  it("lock-screen does not close the interval — it matches Slack", async () => {
    h = await makeHarness();
    const pm = new Emitter();
    wirePowerMonitor({
      powerMonitor: pm as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: null,
    });
    h.source.key(Date.now());
    pm.fire("lock-screen");
    vi.advanceTimersByTime(5 * MIN);
    expect(countIntervals(h.db)).toBe(0);
    pm.fire("unlock-screen");
    expect(h.runtime.liveStatus().openedAtMs).toBe(T0);
  });

  it("shutdown stops the runtime and then exits", async () => {
    h = await makeHarness();
    const pm = new Emitter();
    let exited = 0;
    wirePowerMonitor({
      powerMonitor: pm as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: null,
      onShutdown: () => exited++,
    });
    pm.fire("shutdown");
    await vi.advanceTimersByTimeAsync(0);
    expect(exited).toBe(1);
  });
});

describe("quit", () => {
  it("closes and journals, then exits", async () => {
    h = await makeHarness();
    const app = new Emitter() as unknown as Emitter & Pick<App, "exit">;
    const exits: number[] = [];
    (app as unknown as { exit: (c: number) => void }).exit = (c) => exits.push(c);
    let prevented = 0;

    wireQuit({ app: app as unknown as Pick<App, "on" | "exit">, runtime: h.runtime });
    h.source.key(Date.now());
    (app as unknown as Emitter).fire("before-quit", {
      preventDefault: () => prevented++,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(prevented).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("UI-T08: exits even when stop() never resolves", async () => {
    h = await makeHarness();
    h.runtime.stop = () => new Promise<void>(() => {});
    const app = new Emitter();
    const exits: number[] = [];
    (app as unknown as { exit: (c: number) => void }).exit = (c) => exits.push(c);

    wireQuit({
      app: app as unknown as Pick<App, "on" | "exit">,
      runtime: h.runtime,
      timeoutMs: 4000,
    });
    app.fire("before-quit", { preventDefault: () => {} });

    await vi.advanceTimersByTimeAsync(4500);
    // A menu-bar app you cannot quit is worse than one that quits early: the
    // journal is already durable by this point.
    expect(exits).toEqual([0]);
  });

  it("ignores a second before-quit while the first is in flight", async () => {
    h = await makeHarness();
    const app = new Emitter();
    const exits: number[] = [];
    (app as unknown as { exit: (c: number) => void }).exit = (c) => exits.push(c);
    wireQuit({ app: app as unknown as Pick<App, "on" | "exit">, runtime: h.runtime });
    app.fire("before-quit", { preventDefault: () => {} });
    app.fire("before-quit", { preventDefault: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
  });

  it("withTimeout rejects rather than hanging", async () => {
    const p = withTimeout(new Promise<void>(() => {}), 100);
    const assertion = expect(p).rejects.toThrow(/timeout 100ms/);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });
});

describe("policy and machine id", () => {
  it("maps settings onto the v_countable policy", () => {
    const settings = fakeSettings({
      graceS: 30,
      minIntervalS: 120,
      countJigglerTime: 1,
      heatmapThresholdsH: [3, 6, 9],
    });
    const p = policyFromSettings(settings as unknown as SettingsStore);
    expect(p).toMatchObject({ graceS: 30, minIntervalS: 120, countJigglerTime: true, levelStepH: 3 });
  });

  it("parses IOPlatformUUID out of ioreg", () => {
    const sample = `
    +-o Root  <class IORegistryEntry>
      "IOPlatformUUID" = "5B2C6E11-2C77-4A62-9F3B-9E7D2E4A11CD"
      "IOPlatformSerialNumber" = "C02XYZ"
    `;
    expect(parsePlatformUuid(sample)).toBe("5B2C6E11-2C77-4A62-9F3B-9E7D2E4A11CD");
    // Unparseable is `null`, never a freshly minted id: a machine id that
    // changes forks one Mac's history into two and the union merge then
    // double-counts every overlap.
    expect(parsePlatformUuid("nothing here")).toBeNull();
  });
});
