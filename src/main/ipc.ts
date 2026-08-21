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
  SyncTestResult,
  UiSettings,
} from "../shared/ipc-types";
import { normalizeMachineLabel } from "./device-name";
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
   * Opens the settings window. Optional only so the launched-app smoke run —
   * which registers these handlers itself and opens exactly two windows — does
   * not have to know about a third. Absent, the channel THROWS rather than
   * resolving: a button that silently does nothing is the failure mode this app
   * is built against, and it is better for the renderer to say so.
   */
  readonly showSettings?: () => Promise<unknown> | unknown;
  /**
   * Reads and writes the sync configuration. The URL goes to `settings.json`;
   * the token goes to `safeStorage` and NEVER comes back out over IPC.
   * Absent in tests that do not exercise it, and then the two config channels
   * report an unconfigured install rather than failing.
   */
  readonly syncConfig?: {
    read(): SyncConfigState;
    write(patch: { workerUrl?: string; token?: string }): Promise<SyncConfigState>;
    test(patch: { workerUrl?: string; token?: string }): Promise<SyncTestResult>;
  };
  /**
   * Renames this Mac: `settings.json`, the local `machine` row, and a best-effort
   * heartbeat so the other Mac hears about it. Resolves to the STORED name,
   * which is trimmed and capped and therefore not always what was typed.
   *
   * Absent in tests that do not exercise the database, and then the handler
   * still validates and still persists the setting — it simply has no row to
   * write and no cloud to tell.
   */
  readonly renameMachine?: (raw: string) => Promise<string>;
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

/** PRD §7: "15 minutes, adjustable 10–15 without touching history". */
export const IDLE_TIMEOUT_MIN_RANGE = { min: 10, max: 15 } as const;

/** Bundle ids only, trimmed, de-duplicated, blanks dropped, order preserved. */
function cleanBundleIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    // A blank row is what an empty "add" field leaves behind, and stored it
    // would match nothing forever while looking like a configured entry.
    if (id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The renderer's patch, reduced to values that cannot produce a wrong number.
 *
 * Unknown keys are dropped rather than merged: `settings.json` is spread over
 * the defaults on load, so anything that lands here lands in the file and comes
 * back on every launch afterwards.
 */
export function sanitizeUiSettings(patch: Partial<UiSettings>): Partial<UiSettings> {
  const out: Partial<UiSettings> = {};

  if (patch.machineLabel !== undefined) {
    // Only ever tightened, never invented: `null` (blank after trimming) simply
    // does not reach the store, so a blank name cannot render as a blank row in
    // the machine breakdown.
    const label = normalizeMachineLabel(patch.machineLabel);
    if (label !== null) out.machineLabel = label;
  }

  if (typeof patch.idleTimeoutMin === "number" && Number.isFinite(patch.idleTimeoutMin)) {
    out.idleTimeoutMin = Math.min(
      IDLE_TIMEOUT_MIN_RANGE.max,
      Math.max(IDLE_TIMEOUT_MIN_RANGE.min, Math.round(patch.idleTimeoutMin)),
    );
  }

  if (typeof patch.windowBackground === "string" && /^#[0-9a-fA-F]{6}$/.test(patch.windowBackground)) {
    out.windowBackground = patch.windowBackground;
  }

  const meeting = cleanBundleIds(patch.meetingApps);
  if (meeting !== undefined) out.meetingApps = meeting;
  const micIgnore = cleanBundleIds(patch.micIgnoreApps);
  if (micIgnore !== undefined) out.micIgnoreApps = micIgnore;

  if (Array.isArray(patch.heatmapThresholdsH) && patch.heatmapThresholdsH.length === 3) {
    const [a, b, c] = patch.heatmapThresholdsH.map((n) =>
      typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN,
    ) as [number, number, number];
    // STRICTLY ASCENDING and above zero, or the ramp is rejected whole. A
    // half-applied ramp renders a heatmap whose colours are not ordered, which
    // reads as data rather than as a rejected edit.
    if (a > 0 && b > a && c > b) out.heatmapThresholdsH = [a, b, c];
  }

  if (typeof patch.minIntervalS === "number" && Number.isFinite(patch.minIntervalS)) {
    out.minIntervalS = Math.max(0, Math.round(patch.minIntervalS));
  }
  if (patch.countJigglerTime === 0 || patch.countJigglerTime === 1) {
    out.countJigglerTime = patch.countJigglerTime;
  }
  if (typeof patch.graceS === "number" && Number.isFinite(patch.graceS)) {
    out.graceS = Math.max(0, Math.round(patch.graceS));
  }
  if (typeof patch.syncWorkerUrl === "string") out.syncWorkerUrl = patch.syncWorkerUrl.trim();

  return out;
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
  handle("wwb:sync:test", async (patch) => {
    if (deps.syncConfig === undefined) {
      return {
        ok: false,
        reachable: false,
        authorized: false,
        status: null,
        ms: null,
        error: "this build cannot store a sync configuration",
      };
    }
    // Nothing is written here, on purpose: the whole value of the button is
    // that a wrong answer costs nothing and leaves the stored config alone.
    return await deps.syncConfig.test(patch);
  });

  /**
   * Rename this Mac.
   *
   * NOTHING IS BACKFILLED. `work_interval` stores `machine_id` and never the
   * label, and `byMachine()` LEFT JOINs `machine` for a display name — so this
   * one-row write relabels every interval this Mac has ever recorded, the whole
   * history included, the moment the next query runs. That is the owner's
   * literal requirement, and it is a property of the schema rather than of this
   * handler.
   *
   * Empty-after-trim REJECTS rather than storing `""`. A blank name renders as
   * a blank row in the breakdown, which reads as a bug in the app rather than
   * as a choice the person made.
   */
  handle("wwb:machine:rename", async ({ label }) => {
    if (deps.renameMachine !== undefined) {
      await deps.renameMachine(label);
    } else {
      const next = normalizeMachineLabel(label);
      if (next === null) throw new Error("a device name cannot be empty");
      await deps.settings.set("machineLabel", next);
    }
    // The status strip and the tray both show the machine name, and neither
    // asks again on its own. Push the whole snapshot, the way every other
    // change in this file does.
    pushAll("wwb:push:status", runtime.liveStatus());
    return appInfo();
  });

  handle("wwb:settings:get", () => uiSettingsOf(deps.settings.all()));
  /**
   * Every value is SANITISED here rather than in the pane.
   *
   * The renderer is a view, and a view is exactly the wrong place to enforce an
   * invariant: this channel is also reachable from a devtools console in dev,
   * and `settings.json` is read back on the next launch with no validation at
   * all (`SettingsStore.load()` spreads it over the defaults). An idle timeout
   * of `NaN` would arm a timer that never fires, and thresholds out of order
   * would render a heatmap whose colours mean nothing — both silent.
   */
  handle("wwb:settings:set", async (patch) => {
    const clean = sanitizeUiSettings(patch);
    await deps.settings.patch(clean);
    // A setting that needs a relaunch is a setting the owner has to be warned
    // about. This one does not: the runtime re-arms from the last real signal
    // and no stored `ended_at_ms` moves.
    if (clean.idleTimeoutMin !== undefined) {
      runtime.setIdleTimeoutMs(clean.idleTimeoutMin * 60_000);
    }
    return uiSettingsOf(deps.settings.all());
  });

  handle("wwb:window:openDashboard", async () => {
    await deps.showDashboard();
  });
  handle("wwb:window:openSettings", async () => {
    if (deps.showSettings === undefined) {
      throw new Error("this build has no settings window");
    }
    await deps.showSettings();
  });
  /**
   * The one title-bar behaviour a drag region does not come with. Scoped to the
   * window that asked, so the settings window's title bar zooms the settings
   * window; `maximizable: false` (onboarding, a fixed box) makes it a no-op
   * rather than a resize of a window whose whole layout is sized for 560 × 640.
   */
  handle("wwb:window:zoom", (_payload, e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win === null || win.isDestroyed() || !win.isMaximizable()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
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
