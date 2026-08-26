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
  createSyncConfigGateway,
  onWindowAllClosed,
  policyFromSettings,
  wirePowerMonitor,
  wireQuit,
  wireWindowLifecycle,
  withTimeout,
} from "./bootstrap";
import { createTokenStore, type SecretVault } from "./token";
import type { SyncConfig } from "./sync";
import { parsePlatformUuid } from "./machine-id";
import { MIN, T0, fakeSettings, makeHarness, rows, type Harness } from "../../test/helpers/runtime";
import { countIntervals } from "../store";
import type { SettingsStore } from "./settings";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("resume runs the full sync cycle, not just a flush", async () => {
    h = await makeHarness();
    const cycles: string[] = [];
    const pm = new Emitter();
    wirePowerMonitor({
      powerMonitor: pm as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: null,
      sync: { runCycle: async (reason) => void cycles.push(reason) },
    });

    pm.fire("resume");
    await vi.advanceTimersByTimeAsync(0);

    // Wake is not only "upload what is queued". It is also the pull that
    // backfills the other Mac, the heartbeat that keeps the 72-hour alarm
    // meaningful, and the weekly pass a machine that never quits would
    // otherwise never reach.
    expect(cycles).toEqual(["wake"]);
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

describe("the sync configuration gateway", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wwb-gateway-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const vault: SecretVault = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain, "utf8").toString("base64")}`),
    decryptString: (enc) => Buffer.from(enc.toString("utf8").slice(3), "base64").toString("utf8"),
  };

  function gateway(dir: string) {
    const settings = fakeSettings();
    const applied: Array<SyncConfig | null> = [];
    const g = createSyncConfigGateway({
      settings: settings as unknown as SettingsStore,
      tokens: createTokenStore(() => dir, vault),
      sync: {
        reconfigure: async (config) => void applied.push(config),
      },
    });
    return { g, settings, applied };
  }

  it("needs both halves before it reports configured", async () => {
    const dir = tmp();
    const { g } = gateway(dir);
    expect(g.read()).toMatchObject({ configured: false, tokenPresent: false, error: null });

    expect(await g.write({ workerUrl: "https://wwb-sync.example.workers.dev" })).toMatchObject({
      configured: false,
      tokenPresent: false,
    });
    expect(await g.write({ token: "not-a-real-token-aaaaaaaaaaaa" })).toMatchObject({
      configured: true,
      tokenPresent: true,
    });
  });

  it("applies the change to the live service, so no relaunch is needed", async () => {
    const dir = tmp();
    const { g, applied } = gateway(dir);
    await g.write({
      workerUrl: "https://wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });
    expect(applied.at(-1)).toEqual({
      baseUrl: "https://wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });
  });

  it("puts the URL in settings and the token nowhere a grep can find it", async () => {
    const dir = tmp();
    const { g, settings } = gateway(dir);
    await g.write({
      workerUrl: "https://wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });

    expect(settings.get("syncWorkerUrl")).toBe("https://wwb-sync.example.workers.dev");
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).toString("utf8")).not.toContain("not-a-real-token");
    }
    // …and it never comes back out over the boundary either.
    expect(JSON.stringify(g.read())).not.toContain("not-a-real-token");
  });

  it("says why a malformed URL is unusable instead of silently doing nothing", async () => {
    const { g } = gateway(tmp());
    const state = await g.write({
      workerUrl: "wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });
    expect(state.configured).toBe(false);
    expect(state.tokenPresent).toBe(true);
    expect(state.error).toMatch(/not a URL/);
  });

  it("remembers the second address without ever syncing to it", async () => {
    const dir = tmp();
    const { g, applied } = gateway(dir);
    await g.write({
      workerUrl: "https://wwb.example.test",
      workerUrlAlt: "https://wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });
    expect(g.read().workerUrlAlt).toBe("https://wwb-sync.example.workers.dev");
    // The live configuration is the ONE address. `resolveSyncConfig` does not
    // look at the alternate, deliberately: a second address is a diagnostic and
    // a one-click fallback, not a second thing the flusher reasons about.
    expect(applied.at(-1)).toEqual({
      baseUrl: "https://wwb.example.test",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });
  });

  it("swaps the two addresses through the same funnel as any other change", async () => {
    const dir = tmp();
    const { g, applied } = gateway(dir);
    await g.write({
      workerUrl: "https://wwb.example.test",
      workerUrlAlt: "https://wwb-sync.example.workers.dev",
      token: "not-a-real-token-aaaaaaaaaaaa",
    });

    const swapped = await g.write({
      workerUrl: "https://wwb-sync.example.workers.dev",
      workerUrlAlt: "https://wwb.example.test",
    });

    expect(swapped.workerUrl).toBe("https://wwb-sync.example.workers.dev");
    expect(swapped.workerUrlAlt).toBe("https://wwb.example.test");
    // The flusher was rebuilt, which is the whole reason this goes through
    // `write()` rather than around it.
    expect(applied.at(-1)?.baseUrl).toBe("https://wwb-sync.example.workers.dev");
    // And the token survived a write that did not carry one.
    expect(swapped.tokenPresent).toBe(true);
  });

  it("clears the second address when asked to, and leaves it alone otherwise", async () => {
    const dir = tmp();
    const { g } = gateway(dir);
    await g.write({ workerUrl: "https://a.example.test", workerUrlAlt: "https://b.example.test" });
    // Omitted: untouched. A partial write must not blank a live fallback.
    await g.write({ token: "not-a-real-token-aaaaaaaaaaaa" });
    expect(g.read().workerUrlAlt).toBe("https://b.example.test");
    // "" clears it. That is how a run with only one address says so, and it is
    // what stops a stale fallback outliving the run that created it.
    await g.write({ workerUrlAlt: "" });
    expect(g.read().workerUrlAlt).toBe("");
  });
});
