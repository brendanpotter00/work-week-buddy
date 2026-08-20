/**
 * The IPC contract, both directions.
 *
 * The set-equality test is the load-bearing one: it catches a handler wired up
 * without a contract entry (which would be unreachable from the preload
 * allowlist and fail only at runtime, in the renderer, as `undefined`), and a
 * contract entry with no handler (which rejects with "no handler registered").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../../test/fakes/electron"));

import {
  addFakeWindow,
  ipcMain as fakeIpcMain,
  resetElectronMock,
  senderEvent,
  shell as fakeShell,
} from "../../test/fakes/electron";
import { disposeIpc, isTrustedSenderUrl, pushToAllWindows, registerIpcHandlers } from "./ipc";
import { privacyPaneUrl } from "./onboarding";
import { APP_ORIGIN } from "./protocol";
import { DEFAULT_METRICS_POLICY, INVOKE_CHANNELS } from "../shared/ipc-types";
import { T0, fakeSettings, makeHarness, type Harness } from "../../test/helpers/runtime";
import type { SettingsStore } from "./settings";

let h: Harness;
const stopCalls: string[] = [];

async function register(over: Partial<Parameters<typeof registerIpcHandlers>[1]> = {}) {
  const deps = {
    settings: fakeSettings() as unknown as SettingsStore,
    appVersion: "0.1.0-test",
    isPackaged: false,
    tz: "UTC",
    openPrivacyPane: (which: "inputMonitoring" | "accessibility") =>
      void fakeShell.openExternal(privacyPaneUrl(which)),
    relaunch: () => stopCalls.push("relaunch"),
    closeOnboarding: () => {},
    showDashboard: () => {},
    ...over,
  };
  registerIpcHandlers(h.runtime, deps);
  return deps;
}

function invoke(channel: string, payload?: unknown, url = `${APP_ORIGIN}/index.html`) {
  const handler = fakeIpcMain.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(senderEvent(url), payload);
}

beforeEach(() => {
  resetElectronMock();
  stopCalls.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  disposeIpc();
  h?.close();
  vi.useRealTimers();
});

describe("the channel set", () => {
  it("M12: every contract channel has a handler and every handler is in the contract", async () => {
    h = await makeHarness();
    await register();
    const registered = [...fakeIpcMain.handlers.keys()].sort();
    expect(registered).toEqual([...INVOKE_CHANNELS].sort());
  });
});

describe("sender validation", () => {
  it("M11: a page that is not ours gets an error, not data", async () => {
    h = await makeHarness();
    await register();
    expect(isTrustedSenderUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isTrustedSenderUrl("https://evil.example/")).toBe(false);
    expect(isTrustedSenderUrl("file:///etc/passwd")).toBe(false);
    await expect(
      invoke("wwb:status:get", undefined, "https://evil.example/"),
    ).rejects.toThrow(/untrusted IPC sender/);
  });
});

describe("the handlers", () => {
  it("return whole snapshots, so the renderer never guesses what changed", async () => {
    h = await makeHarness();
    await register();

    const info = (await invoke("wwb:app:info")) as { machineId: string; tz: string };
    expect(info.machineId).toBe("machine-a");
    expect(info.tz).toBe("UTC");

    const status = (await invoke("wwb:status:get")) as { state: string; deadlineMs: number | null };
    expect(status.state).toBe("idle");
    // Display-only, and absolute: never a duration on the wire.
    expect(status.deadlineMs).toBeNull();

    const toggles = (await invoke("wwb:toggles:set", {
      key: "keepAwake",
      value: true,
      source: "dashboard",
    })) as { keepAwake: boolean };
    expect(toggles.keepAwake).toBe(true);

    const metrics = (await invoke("wwb:metrics:get", DEFAULT_METRICS_POLICY)) as {
      weekBars: unknown[];
      week: { hours: number | null };
    };
    expect(metrics.weekBars).toHaveLength(7);
    expect(metrics.week.hours).toBeNull();
  });

  it("opens the right Privacy pane", async () => {
    h = await makeHarness();
    await register();
    await invoke("wwb:permissions:openSettings", "accessibility");
    expect(fakeShell.opened.at(-1)).toContain("Privacy_Accessibility");
  });

  it("UI-T12: relaunch closes the interval BEFORE relaunching", async () => {
    h = await makeHarness();
    const order: string[] = [];
    const realStop = h.runtime.stop.bind(h.runtime);
    h.runtime.stop = async (reason) => {
      order.push("stop");
      await realStop(reason);
    };
    await register({ relaunch: () => order.push("relaunch") });

    await invoke("wwb:permissions:relaunch");
    // Relaunching first would lose up to fifteen minutes to crash recovery for
    // no reason at all.
    expect(order).toEqual(["stop", "relaunch"]);
  });

  it("dismissing onboarding does not silence a missing grant", async () => {
    h = await makeHarness();
    const settings = fakeSettings();
    let closed = 0;
    await register({
      settings: settings as unknown as SettingsStore,
      closeOnboarding: () => closed++,
    });
    await invoke("wwb:onboarding:dismiss");
    expect(settings.get("onboardingDismissed")).toBe(true);
    expect(closed).toBe(1);

    h.source.stripKeyboardBits();
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());
    const status = (await invoke("wwb:status:get")) as { degraded: string[] };
    expect(status.degraded).toContain("keyboard_permission_missing");
  });

  it("truncates a renamed machine label rather than storing an essay", async () => {
    h = await makeHarness();
    const settings = fakeSettings();
    await register({ settings: settings as unknown as SettingsStore });
    await invoke("wwb:machine:rename", { label: `  ${"x".repeat(200)}  ` });
    expect(settings.get("machineLabel")).toHaveLength(60);
  });
});

describe("push fan-out", () => {
  it("never pushes a 'signal' change", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();
    for (let i = 0; i < 300; i++) pushToAllWindows(h.runtime, "signal");
    expect(win.sent).toHaveLength(0);
  });

  it("M08: debounces metrics-stale to one message for a burst of closes", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();

    for (let i = 0; i < 5; i++) {
      pushToAllWindows(h.runtime, "interval-close");
      vi.advanceTimersByTime(100);
    }
    expect(win.sent.filter((m) => m.channel === "wwb:push:metrics-stale")).toHaveLength(0);
    vi.advanceTimersByTime(2000);

    const stale = win.sent.filter((m) => m.channel === "wwb:push:metrics-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.payload).toEqual({ reason: "interval-close" });
    // Status is a complete snapshot and is pushed for every close.
    expect(win.sent.filter((m) => m.channel === "wwb:push:status")).toHaveLength(5);
  });

  it("pushes nothing at all when no window exists", async () => {
    h = await makeHarness();
    await register();
    expect(() => pushToAllWindows(h.runtime, "interval-close")).not.toThrow();
    vi.advanceTimersByTime(5000);
  });

  it("a toggle change pushes both toggles and status", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();
    pushToAllWindows(h.runtime, "toggles");
    expect(win.sent.map((m) => m.channel)).toEqual(["wwb:push:toggles", "wwb:push:status"]);
  });

  it("the 30 s keepalive converges a window that missed a push", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();
    vi.advanceTimersByTime(30_000);
    expect(win.sent.filter((m) => m.channel === "wwb:push:status")).toHaveLength(1);
  });
});
