/**
 * The IPC handlers — `docs/IMPL_UI.md` §2.6.
 *
 * Rules this file enforces, all of which are structural rather than advisory:
 *
 * 1. **The renderer never mutates state directly.** Every mutation is an
 *    `invoke` that returns the NEW FULL STATE object, so the renderer never has
 *    to guess what changed.
 * 2. **Every push payload is a complete snapshot**, never a delta. Deltas need
 *    ordering guarantees IPC does not give you.
 * 3. **Every handler validates its sender.** A page that is not ours gets an
 *    error, not data.
 * 4. **The renderer has no database handle.** There is no channel that returns
 *    one, and `INVOKE_CHANNELS` in the preload is the allowlist.
 * 5. **The 15-minute deadline never crosses IPC as a duration.**
 *    `LiveStatus.deadlineMs` is absolute and display-only; no renderer may
 *    schedule from it. AGENTS.md trap #10.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import type {
  AppInfo,
  InvokeChannel,
  InvokeContract,
  PushChannel,
  PushContract,
  SyncConfigState,
  UiSettings,
} from "../shared/ipc-types";
import { log } from "./log";
import { APP_ORIGIN } from "./protocol";
import type { AppRuntime, RuntimeChange } from "./runtime";
import type { MainSettings, SettingsStore } from "./settings";

const isDev = (): boolean => !!process.env["ELECTRON_RENDERER_URL"];

/** A page that is not ours gets an error, not data. */
export function isTrustedSenderUrl(url: string): boolean {
  return url.startsWith(APP_ORIGIN) || (isDev() && url.startsWith("http://localhost:"));
}

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? "";
  if (!isTrustedSenderUrl(url)) throw new Error(`untrusted IPC sender: ${url}`);
}

function handle<K extends InvokeChannel>(
  channel: K,
  fn: (
    payload: InvokeContract[K]["req"],
    e: IpcMainInvokeEvent,
  ) => Promise<InvokeContract[K]["res"]> | InvokeContract[K]["res"],
): void {
  ipcMain.handle(channel, async (e, payload) => {
    assertTrustedSender(e);
    try {
      return await fn(payload as InvokeContract[K]["req"], e);
    } catch (err) {
      log.error(`ipc ${channel} failed`, err);
      // Surfaces as a rejected promise in the renderer rather than a silent
      // undefined that renders as a blank card.
      throw err;
    }
  });
}

export function push<K extends PushChannel>(
  win: BrowserWindow,
  channel: K,
  payload: PushContract[K],
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function pushAll<K extends PushChannel>(channel: K, payload: PushContract[K]): void {
  for (const w of BrowserWindow.getAllWindows()) push(w, channel, payload);
}

let staleTimer: NodeJS.Timeout | null = null;
let statusKeepalive: NodeJS.Timeout | null = null;

/**
 * Called from the single runtime `change` subscription in `bootstrap.ts`.
 *
 * `metrics-stale` is an INVALIDATION, not the metrics: the six queries take a
 * policy the renderer owns and main does not know which one is on screen.
 * Pushing an invalidation and letting the renderer re-ask is one round trip and
 * zero divergence.
 */
export function pushToAllWindows(runtime: AppRuntime, kind: RuntimeChange): void {
  if (BrowserWindow.getAllWindows().length === 0) return;

  switch (kind) {
    case "signal":
      // The renderer ticks its own 1 Hz display clock and recomputes from the
      // absolutes it already has. Spamming IPC buys nothing.
      return;
    case "toggles":
      pushAll("wwb:push:toggles", runtime.toggles());
      pushAll("wwb:push:status", runtime.liveStatus());
      return;
    case "permissions":
      pushAll("wwb:push:permissions", runtime.permissions());
      // `Toggles.jigglerAvailable` is DERIVED from the Accessibility grant
      // (`runtime.toggles()`), so a permission change is also a toggles change.
      // Without this the onboarding window grants Accessibility, the badge
      // flips to "Granted", and the jiggler switch beside it stays greyed out
      // until the window is reopened — the exact "it says yes and does nothing"
      // shape this app is built against.
      pushAll("wwb:push:toggles", runtime.toggles());
      pushAll("wwb:push:status", runtime.liveStatus());
      return;
    case "interval-close":
    case "rows-pulled": {
      pushAll("wwb:push:status", runtime.liveStatus());
      if (staleTimer) clearTimeout(staleTimer);
      const reason = kind === "rows-pulled" ? "rows-pulled" : "interval-close";
      staleTimer = setTimeout(() => {
        staleTimer = null;
        pushAll("wwb:push:metrics-stale", { reason });
      }, 2000);
      return;
    }
    default:
      pushAll("wwb:push:status", runtime.liveStatus());
  }
}

export interface IpcDeps {
  readonly settings: SettingsStore;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly tz: string;
  readonly openPrivacyPane: (which: "inputMonitoring" | "accessibility") => void;
  readonly relaunch: () => void;
  readonly closeOnboarding: () => void;
  readonly showDashboard: () => Promise<unknown> | unknown;
  /**
   * Reads and writes the sync configuration. The URL goes to `settings.json`;
   * the token goes to `safeStorage` and NEVER comes back out over IPC.
   * Absent in tests that do not exercise it, and then the two config channels
   * report an unconfigured install rather than failing.
   */
  readonly syncConfig?: {
    read(): SyncConfigState;
    write(patch: { workerUrl?: string; token?: string }): Promise<SyncConfigState>;
  };
  /** Test seam so the 30 s keepalive can be driven by fake timers. */
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

function uiSettingsOf(s: Readonly<MainSettings>): UiSettings {
  return {
    machineLabel: s.machineLabel,
    idleTimeoutMin: s.idleTimeoutMin,
    windowBackground: s.windowBackground,
    meetingApps: s.meetingApps,
    micIgnoreApps: s.micIgnoreApps,
    heatmapThresholdsH: s.heatmapThresholdsH,
    minIntervalS: s.minIntervalS,
    countJigglerTime: s.countJigglerTime,
    graceS: s.graceS,
    syncWorkerUrl: s.syncWorkerUrl,
  };
}

export function registerIpcHandlers(runtime: AppRuntime, deps: IpcDeps): void {
  const appInfo = (): AppInfo => ({
    version: deps.appVersion,
    machineId: runtime.machineId,
    machineLabel: deps.settings.get("machineLabel"),
    tz: deps.tz,
    isPackaged: deps.isPackaged,
    idleTimeoutMin: deps.settings.get("idleTimeoutMin"),
  });

  handle("wwb:app:info", () => appInfo());
  handle("wwb:status:get", () => runtime.liveStatus());
  handle("wwb:metrics:get", (policy) => runtime.metrics(policy));
  handle("wwb:toggles:get", () => runtime.toggles());
  handle("wwb:toggles:set", (change) => runtime.setToggle(change));

  handle("wwb:permissions:get", () => runtime.permissions());
  handle("wwb:permissions:refresh", () => runtime.refreshPermissions());
  handle("wwb:permissions:request", (which) => runtime.requestPermission(which));
  handle("wwb:permissions:openSettings", (which) => {
    deps.openPrivacyPane(which);
  });
  handle("wwb:permissions:relaunch", async () => {
    // Close and journal FIRST. Relaunching without this loses up to fifteen
    // minutes to crash recovery for no reason at all.
    await runtime.stop("app_quit");
    deps.relaunch();
  });

  handle("wwb:onboarding:dismiss", async () => {
    // Dismissing onboarding is NOT consent to bad data: a missing keyboard
    // grant keeps the banner and the tray warning, forever, until it is fixed.
    await deps.settings.set("onboardingDismissed", true);
    deps.closeOnboarding();
  });

  handle("wwb:doctor:get", () => runtime.doctor());
  handle("wwb:doctor:selftest", () => runtime.selfTest());
  handle("wwb:sync:flush", () => runtime.flushNow());

  const noSyncConfig = (): SyncConfigState => ({
    workerUrl: deps.settings.get("syncWorkerUrl"),
    tokenPresent: false,
    configured: false,
    error: null,
    vaultAvailable: false,
  });
  handle("wwb:sync:config", () => deps.syncConfig?.read() ?? noSyncConfig());
  handle("wwb:sync:setConfig", async (patch) => {
    // The token arrives, is encrypted, and is forgotten. What goes back is a
    // boolean saying one exists — never the token, in any shape.
    if (deps.syncConfig === undefined) return noSyncConfig();
    return await deps.syncConfig.write(patch);
  });

  handle("wwb:machine:rename", async ({ label }) => {
    await deps.settings.set("machineLabel", label.trim().slice(0, 60));
    return appInfo();
  });

  handle("wwb:settings:get", () => uiSettingsOf(deps.settings.all()));
  handle("wwb:settings:set", async (patch) => {
    await deps.settings.patch(patch);
    return uiSettingsOf(deps.settings.all());
  });

  handle("wwb:window:openDashboard", async () => {
    await deps.showDashboard();
  });

  // 30 s keepalive so a window created mid-change converges even if it missed
  // the push that carried the change.
  const setRepeating = deps.setRepeating ?? setInterval;
  statusKeepalive = setRepeating(() => {
    if (BrowserWindow.getAllWindows().length === 0) return;
    pushAll("wwb:push:status", runtime.liveStatus());
  }, 30_000);
}

/** Tear-down, for tests and for quit. */
export function disposeIpc(): void {
  if (statusKeepalive) {
    clearInterval(statusKeepalive);
    statusKeepalive = null;
  }
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
}
