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
import { IDLE_TIMEOUT_MIN_RANGE } from "../shared/constants";
import { DEFAULT_METRICS_POLICY, INVOKE_CHANNELS } from "../shared/ipc-types";
import { MIN, T0, fakeSettings, makeHarness, type Harness } from "../../test/helpers/runtime";
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

  it("refuses a blank rename rather than storing an empty name", async () => {
    h = await makeHarness();
    const settings = fakeSettings({ machineLabel: "MacBook Pro" });
    await register({ settings: settings as unknown as SettingsStore });

    // `""` would render as a blank row in the per-machine breakdown, which
    // reads as a broken app rather than as a choice somebody made. The renderer
    // sees a rejected invoke and says so.
    await expect(invoke("wwb:machine:rename", { label: "   " })).rejects.toThrow(
      /cannot be empty/,
    );
    expect(settings.get("machineLabel")).toBe("MacBook Pro");
  });

  it("hands the rename to main's naming service when there is one", async () => {
    h = await makeHarness();
    const renamed: string[] = [];
    const settings = fakeSettings({ machineLabel: "MacBook Pro" });
    await register({
      settings: settings as unknown as SettingsStore,
      renameMachine: async (raw: string) => {
        renamed.push(raw);
        await settings.set("machineLabel", raw.trim());
        return raw.trim();
      },
    });
    const win = addFakeWindow();

    const info = (await invoke("wwb:machine:rename", {
      label: " The loft mini ",
    })) as { machineLabel: string };

    // One writer, not two: the handler must not also write the setting itself,
    // or the local `machine` row and `settings.json` could disagree.
    expect(renamed).toEqual([" The loft mini "]);
    expect(info.machineLabel).toBe("The loft mini");
    // The status strip and the tray both show the name and neither re-asks on
    // its own, so the rename pushes a whole fresh snapshot.
    expect(win.sent.map((s) => s.channel)).toContain("wwb:push:status");
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

  it("a permission change also pushes toggles, because jigglerAvailable is derived from it", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();
    pushToAllWindows(h.runtime, "permissions");
    // The onboarding window shows the Accessibility badge and the jiggler
    // switch side by side. Pushing only the snapshot flips the badge to
    // "Granted" and leaves the switch disabled until the window is reopened.
    expect(win.sent.map((m) => m.channel)).toEqual([
      "wwb:push:permissions",
      "wwb:push:toggles",
      "wwb:push:status",
    ]);
  });

  it("the 30 s keepalive converges a window that missed a push", async () => {
    h = await makeHarness();
    await register();
    const win = addFakeWindow();
    vi.advanceTimersByTime(30_000);
    expect(win.sent.filter((m) => m.channel === "wwb:push:status")).toHaveLength(1);
  });
});

describe("the sync configuration channels", () => {
  it("takes a token and never gives one back", async () => {
    h = await makeHarness();
    const written: Array<{ workerUrl?: string; token?: string }> = [];
    let tokenPresent = false;
    await register({
      syncConfig: {
        read: () => ({
          workerUrl: "https://wwb-sync.example.workers.dev",
          workerUrlAlt: "",
          tokenPresent,
          configured: tokenPresent,
          error: null,
          vaultAvailable: true,
        }),
        write: async (patch) => {
          written.push(patch);
          if (patch.token !== undefined) tokenPresent = true;
          return {
            workerUrl: patch.workerUrl ?? "https://wwb-sync.example.workers.dev",
            workerUrlAlt: "",
            tokenPresent,
            configured: tokenPresent,
            error: null,
            vaultAvailable: true,
          };
        },
        test: async () => ({
          ok: true,
          reachable: true,
          authorized: true,
          status: 200,
          ms: 12,
          error: null,
          alt: null,
        }),
      },
    });

    const before = await invoke("wwb:sync:config");
    expect(before).toMatchObject({ tokenPresent: false, configured: false });

    const after = await invoke("wwb:sync:setConfig", { token: "not-a-real-token-aaaaaaaa" });
    expect(after).toMatchObject({ tokenPresent: true, configured: true });
    // The token reached the vault and NOT the renderer. A secret that crosses
    // this boundary is a secret in a devtools console.
    expect(written).toEqual([{ token: "not-a-real-token-aaaaaaaa" }]);
    expect(JSON.stringify(after)).not.toContain("not-a-real-token");
  });

  it("reports an unconfigured install when no gateway is wired", async () => {
    h = await makeHarness();
    await register();
    expect(await invoke("wwb:sync:config")).toMatchObject({
      configured: false,
      tokenPresent: false,
      vaultAvailable: false,
    });
  });

  it("carries the Worker URL through the ordinary settings channel", async () => {
    h = await makeHarness();
    const deps = await register();
    const updated = await invoke("wwb:settings:set", {
      syncWorkerUrl: "https://wwb-sync.example.workers.dev",
      syncWorkerUrlAlt: "",
    });
    // A URL is not a credential, so it lives in settings.json like any other.
    expect(updated).toMatchObject({ syncWorkerUrl: "https://wwb-sync.example.workers.dev" });
    expect(deps.settings.get("syncWorkerUrl")).toBe("https://wwb-sync.example.workers.dev");
  });

  it("keeps the token out of settings.json entirely — that file is plaintext on disk", async () => {
    h = await makeHarness();
    const vaulted: string[] = [];
    const deps = await register({
      syncConfig: {
        read: () => ({
          workerUrl: "https://wwb-sync.example.workers.dev",
          workerUrlAlt: "",
          tokenPresent: vaulted.length > 0,
          configured: vaulted.length > 0,
          error: null,
          vaultAvailable: true,
        }),
        write: async (patch) => {
          if (patch.token !== undefined) vaulted.push(patch.token);
          return {
            workerUrl: "https://wwb-sync.example.workers.dev",
            workerUrlAlt: "",
            tokenPresent: true,
            configured: true,
            error: null,
            vaultAvailable: true,
          };
        },
        test: async () => ({
          ok: true,
          reachable: true,
          authorized: true,
          status: 200,
          ms: 1,
          error: null,
          alt: null,
        }),
      },
    });

    const token = "wwb_9f3c1d7a54e84b0da2c6f18e7b3a09d5";
    await invoke("wwb:sync:setConfig", {
      workerUrl: "https://wwb-sync.example.workers.dev",
      token,
    });

    // It reached the vault…
    expect(vaulted).toEqual([token]);
    // …and NOT the settings file, which `SettingsStore.save()` writes as
    // plaintext JSON beside the database. AGENTS.md, "Secrets".
    expect(JSON.stringify(deps.settings.all())).not.toContain(token);
    // Nor can it be read back out through any channel that answers.
    expect(JSON.stringify(await invoke("wwb:sync:config"))).not.toContain(token);
    expect(JSON.stringify(await invoke("wwb:settings:get"))).not.toContain(token);
    expect(JSON.stringify(await invoke("wwb:doctor:get"))).not.toContain(token);
  });

  it("tests a configuration without storing any part of it", async () => {
    h = await makeHarness();
    const written: unknown[] = [];
    const tested: unknown[] = [];
    const deps = await register({
      syncConfig: {
        read: () => ({
          workerUrl: "",
          workerUrlAlt: "",
          tokenPresent: false,
          configured: false,
          error: null,
          vaultAvailable: true,
        }),
        write: async (patch) => {
          written.push(patch);
          return {
            workerUrl: "",
            workerUrlAlt: "",
            tokenPresent: false,
            configured: false,
            error: null,
            vaultAvailable: true,
          };
        },
        test: async (patch) => {
          tested.push(patch);
          return {
            ok: false,
            reachable: true,
            authorized: false,
            status: 401,
            ms: 30,
            error: "the Worker is reachable but rejected this token",
            alt: null,
          };
        },
      },
    });

    const result = (await invoke("wwb:sync:test", {
      workerUrl: "https://wwb-sync.example.workers.dev",
      token: "wrong-one",
    })) as { reachable: boolean; authorized: boolean };

    // Reachable and unauthorized are separate answers: they need different
    // fixes, and one boolean cannot tell them apart.
    expect(result.reachable).toBe(true);
    expect(result.authorized).toBe(false);
    expect(tested).toHaveLength(1);
    // Nothing was saved. That is the entire value of testing first.
    expect(written).toHaveLength(0);
    expect(deps.settings.get("syncWorkerUrl")).toBe("");
  });

  it("answers honestly when no gateway is wired, rather than claiming a green test", async () => {
    h = await makeHarness();
    await register();
    const result = (await invoke("wwb:sync:test", {})) as { ok: boolean; error: string | null };
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

describe("the settings channel validates before it persists", () => {
  it("clamps the idle timeout to the range the PRD allows, and applies it live", async () => {
    h = await makeHarness();
    const deps = await register();

    // PRD §7: "15 minutes, adjustable 2–15 without touching history".
    await invoke("wwb:settings:set", { idleTimeoutMin: 90 });
    expect(deps.settings.get("idleTimeoutMin")).toBe(15);
    await invoke("wwb:settings:set", { idleTimeoutMin: 1 });
    expect(deps.settings.get("idleTimeoutMin")).toBe(2);
    await invoke("wwb:settings:set", { idleTimeoutMin: 12 });
    expect(deps.settings.get("idleTimeoutMin")).toBe(12);
  });

  it("lets a value below the OLD 10-minute floor through unchanged", async () => {
    // THE TEST THAT PROVES THE DOUBLE BOUND IS ACTUALLY GONE.
    //
    // The range lived in two places: the slider in `src/renderer/Settings.tsx`
    // and `IDLE_TIMEOUT_MIN_RANGE` here. Widening only the slider would have
    // looked completely correct in the pane — drag to 3, watch it snap back to
    // 10 on the next render, with nothing logged and nothing thrown, because
    // this sanitiser had quietly clamped it. Every value the slider can now
    // reach has to survive the round trip through main, and this is the one
    // that would not have.
    h = await makeHarness();
    const deps = await register();

    for (const min of [2, 3, 5, 9]) {
      const back = (await invoke("wwb:settings:set", { idleTimeoutMin: min })) as {
        idleTimeoutMin: number;
      };
      // Both halves of the round trip: what was stored, and what came back to
      // the renderer that will re-render the slider from it.
      expect(deps.settings.get("idleTimeoutMin")).toBe(min);
      expect(back.idleTimeoutMin).toBe(min);
    }
  });

  it("clamps below the NEW floor rather than accepting a sub-countable timeout", async () => {
    // 1 minute is 60 s, under the 90-second `v_countable` floor — accepting it
    // would let a session be closed by a gap shorter than the shortest session
    // the app will ever count. Clamped, never taken.
    h = await makeHarness();
    const deps = await register();

    for (const min of [0, 1, -5]) {
      await invoke("wwb:settings:set", { idleTimeoutMin: min });
      expect(deps.settings.get("idleTimeoutMin")).toBe(IDLE_TIMEOUT_MIN_RANGE.min);
    }
    expect(IDLE_TIMEOUT_MIN_RANGE.min * 60).toBeGreaterThanOrEqual(
      deps.settings.get("minIntervalS"),
    );
  });

  it("re-arms the live deadline from the last real signal when the timeout shortens", async () => {
    // "Without touching history" is the promise in PRD §7, and it is what makes
    // widening the range safe: a new value re-arms the NEXT deadline from the
    // last real signal and moves no `ended_at_ms` that has already been
    // written. Asserted through the channel, not through the runtime method, so
    // the wiring in the handler is what is under test.
    h = await makeHarness();
    await register();
    h.source.key(Date.now());
    expect(h.runtime.liveStatus().deadlineMs).toBe(T0 + 15 * MIN);

    await invoke("wwb:settings:set", { idleTimeoutMin: 3 });
    expect(h.runtime.liveStatus().deadlineMs).toBe(T0 + 3 * MIN);
  });

  it("drops a NaN idle timeout instead of arming a timer that never fires", async () => {
    h = await makeHarness();
    const deps = await register();
    await invoke("wwb:settings:set", { idleTimeoutMin: Number.NaN });
    expect(deps.settings.get("idleTimeoutMin")).toBe(15);
  });

  it("rejects a heatmap ramp whole rather than storing half of one", async () => {
    h = await makeHarness();
    const deps = await register();
    const before = deps.settings.get("heatmapThresholdsH");

    // Out of order: the colours would no longer be ordered, which reads as data
    // rather than as a rejected edit.
    await invoke("wwb:settings:set", { heatmapThresholdsH: [9, 5, 8] });
    expect(deps.settings.get("heatmapThresholdsH")).toEqual(before);

    await invoke("wwb:settings:set", { heatmapThresholdsH: [3, 6, 9] });
    expect(deps.settings.get("heatmapThresholdsH")).toEqual([3, 6, 9]);
  });

  it("silently ignores the retired mic bundle-id lists instead of storing them", async () => {
    // REPLACES a test that asserted these were cleaned and persisted. The mic
    // conjunction is gone (PRD §3.5), so `meetingApps`/`micIgnoreApps` are no
    // longer settings at all — but an older renderer, or an older
    // `settings.json` echoed back through a patch, can still send them. They
    // must go no further: no throw, no rejected write, no key in the file.
    h = await makeHarness();
    const deps = await register();
    const before = deps.settings.get("idleTimeoutMin");

    await invoke("wwb:settings:set", {
      meetingApps: ["us.zoom.xos", "com.hnc.Discord"],
      micIgnoreApps: ["com.electron.wispr-flow"],
      idleTimeoutMin: 11,
    } as never);

    expect(deps.settings.all()).not.toHaveProperty("meetingApps");
    expect(deps.settings.all()).not.toHaveProperty("micIgnoreApps");
    // The legitimate half of the same patch still landed.
    expect(deps.settings.get("idleTimeoutMin")).toBe(11);
    expect(before).not.toBe(11);
  });

  it("refuses a blank machine label rather than storing an empty row label", async () => {
    h = await makeHarness();
    const deps = await register();
    const before = deps.settings.get("machineLabel");
    await invoke("wwb:settings:set", { machineLabel: "   " });
    expect(deps.settings.get("machineLabel")).toBe(before);
  });
});

describe("the settings window", () => {
  it("is reachable over its own channel", async () => {
    h = await makeHarness();
    const opened: string[] = [];
    await register({ showSettings: () => opened.push("settings") });
    await invoke("wwb:window:openSettings");
    expect(opened).toEqual(["settings"]);
  });

  it("throws rather than silently doing nothing when no window is wired", async () => {
    // A button that does nothing is the failure this app is built against; a
    // rejected invoke at least reaches the renderer as words.
    h = await makeHarness();
    await register();
    await expect(invoke("wwb:window:openSettings")).rejects.toThrow(/settings window/);
  });
});

describe("double-click on the title bar", () => {
  /** `invoke`, but from a specific window rather than from nowhere. */
  function invokeFrom(win: ReturnType<typeof addFakeWindow>, channel: string) {
    const handler = fakeIpcMain.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(senderEvent(`${APP_ORIGIN}/index.html`, win), undefined);
  }

  it("zooms the window that was double-clicked, and un-zooms on the next one", async () => {
    // A `-webkit-app-region: drag` region gets NO double-click behaviour from
    // macOS — measured on Electron 43 — so the one thing a real title bar does
    // that a drag region does not is wired here.
    h = await makeHarness();
    await register();
    const dashboard = addFakeWindow();
    const other = addFakeWindow();

    await invokeFrom(dashboard, "wwb:window:zoom");
    expect(dashboard.isMaximized()).toBe(true);
    // Scoped to the sender: the settings window's title bar must not zoom the
    // dashboard.
    expect(other.isMaximized()).toBe(false);

    await invokeFrom(dashboard, "wwb:window:zoom");
    expect(dashboard.isMaximized()).toBe(false);
    expect(dashboard.zoomCalls).toEqual(["maximize", "unmaximize"]);
  });

  it("does nothing to a window that cannot be maximized", async () => {
    // Onboarding is `maximizable: false` — a fixed 560 × 640 whose whole layout
    // is sized for that rectangle. A double-click there is a no-op, not a
    // resize into a shape nothing was measured against.
    h = await makeHarness();
    await register();
    const onboarding = addFakeWindow({ maximizable: false });

    await invokeFrom(onboarding, "wwb:window:zoom");
    expect(onboarding.zoomCalls).toEqual([]);
    expect(onboarding.isMaximized()).toBe(false);
  });

  it("does not throw when the sender has no window at all", async () => {
    h = await makeHarness();
    await register();
    await expect(invoke("wwb:window:zoom")).resolves.toBeUndefined();
  });
});

describe("the self-test", () => {
  it("has no IPC channel of its own — nothing in the renderer may start one", async () => {
    // `wwb:doctor:selftest` outlived the Settings card that was its only caller
    // (#29). The check posts synthetic events and deliberately blocks the tap
    // for 2.5 s, so a channel that can start one and that nobody reviews is a
    // real hazard, not tidiness. The M12 test above proves main registers
    // exactly the contract; this proves the contract no longer has it.
    expect([...INVOKE_CHANNELS]).not.toContain("wwb:doctor:selftest");
  });

  it("runs, and the result outlives the run so the pane can say when it passed", async () => {
    h = await makeHarness();
    await register();

    const before = (await invoke("wwb:doctor:get")) as { selfTest: unknown };
    expect(before.selfTest).toBeNull();

    // Straight at the runtime now: this is the path the jiggler toggle takes,
    // and `--selftest` is the other one. Neither goes through IPC.
    const result = await h.runtime.selfTest();
    expect(result.passed).toBe(true);

    // The doctor reports the STORED result rather than running a fresh one:
    // the self-test posts synthetic events, so reading the report must not
    // change what the report is about.
    const after = (await invoke("wwb:doctor:get")) as { selfTest: { ranAtMs: number } | null };
    expect(after.selfTest?.ranAtMs).toBe(result.ranAtMs);
  });
});
