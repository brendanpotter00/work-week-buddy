/**
 * Boot order and lifecycle wiring — `docs/IMPL_UI.md` §1.1 and §1.3.
 *
 * Split out of `index.ts` so every wire in it can be exercised by a test: the
 * entry file is unavoidably a pile of module-scope side effects, and the rules
 * that matter (a closed window must not stop tracking, sleep must not close an
 * interval, quit must not hang forever) are exactly the ones you cannot test
 * from inside a pile of module-scope side effects.
 *
 * Order below is load-bearing. Each step is where it is for a reason; the table
 * in `docs/IMPL_UI.md` §1.1 has the whys.
 */
import { randomUUID } from "node:crypto";
import type { App, PowerMonitor } from "electron";

import { createSignalSource, type SignalSource } from "../native";
import { DEFAULT_POLICY, defaultDbPath, openDb, type Policy } from "../store";
import { log } from "./log";
import { createRuntime, type AppRuntime } from "./runtime";
import { readPlatformUuid } from "./machine-id";
import type { SettingsStore } from "./settings";
import type { TrayController } from "./tray";
import { createWatchdog, type Watchdog } from "./watchdog";

/**
 * The window is a VIEW, not the app.
 *
 * Deliberately does nothing. Closing the dashboard must not stop tracking and
 * must not freeze the tray title: the reducer, the deadline, the watchdog and
 * the tray's minute timer all live in the main process and are owned by no
 * window. Returning early here — or, worse, calling `app.quit()` — would end
 * the working day the moment someone pressed ⌘W.
 */
export function onWindowAllClosed(): void {
  // intentionally empty
}

export function wireWindowLifecycle(deps: {
  app: Pick<App, "on">;
  hasWindows: () => boolean;
  showDashboard: () => void;
}): void {
  deps.app.on("window-all-closed", onWindowAllClosed);
  deps.app.on("activate", () => {
    if (!deps.hasWindows()) deps.showDashboard();
  });
}

export interface PowerDeps {
  powerMonitor: Pick<PowerMonitor, "on">;
  runtime: AppRuntime;
  tray: Pick<TrayController, "refresh"> | null;
  now?: () => number;
  onShutdown?: () => void;
}

/**
 * Power events, stated once, because "what closes an interval" is exactly the
 * class of decision that goes wrong quietly.
 *
 * | event | closes? | also does |
 * |---|---|---|
 * | `suspend` | **no** | journals the open interval |
 * | `resume` | only if the deadline passed while asleep, and then AT THE PRE-SLEEP SIGNAL | re-reads levels, flushes, refreshes the tray |
 * | `lock-screen` | **no** — matches Slack, PRD §3.2 | journal only |
 * | `unlock-screen` | no | re-evaluates the deadline |
 * | `shutdown` | yes | stop() then exit |
 */
export function wirePowerMonitor(deps: PowerDeps): void {
  const now = deps.now ?? Date.now;
  let suspendedAtMs: number | null = null;

  deps.powerMonitor.on("suspend", () => {
    const at = now();
    suspendedAtMs = at;
    // Sleep does NOT close the interval. The countdown simply does not run; on
    // resume the wall-clock comparison decides. ARCHITECTURE §3.4.
    void deps.runtime.onSuspend(at);
  });

  deps.powerMonitor.on("resume", () => {
    const at = now();
    const from = suspendedAtMs;
    suspendedAtMs = null;
    void (async () => {
      // ORDER MATTERS: re-evaluate the deadline — which may close an interval
      // at the pre-sleep signal — BEFORE flushing, so the closed row is already
      // in the outbox on the first flush after waking.
      await deps.runtime.onResume(at, from);
      deps.tray?.refresh("resume");
      await deps.runtime.flushNow().catch(() => undefined);
    })();
  });

  deps.powerMonitor.on("lock-screen", () => deps.runtime.onScreenLock(now()));
  deps.powerMonitor.on("unlock-screen", () => {
    deps.runtime.onScreenUnlock(now());
    deps.tray?.refresh("unlock");
  });

  // macOS delivers this on logout/restart/shutdown. There is no reliable
  // preventDefault on darwin, so keep the handler short.
  deps.powerMonitor.on("shutdown", () => {
    void deps.runtime.stop("app_quit").finally(() => deps.onShutdown?.());
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

/**
 * ⌘Q. Closes and journals, then exits — but NEVER waits forever: a `stop()`
 * that hangs on a network flush would leave a menu-bar app that cannot be
 * quit, and the journal is already durable by then anyway.
 */
export function wireQuit(deps: {
  app: Pick<App, "on" | "exit">;
  runtime: AppRuntime;
  onBeforeExit?: () => void;
  timeoutMs?: number;
}): void {
  let quitting = false;
  deps.app.on("before-quit", (e: Electron.Event) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await withTimeout(deps.runtime.stop("app_quit"), deps.timeoutMs ?? 4000);
      } catch (err) {
        log.error("stop() on quit failed", err);
      } finally {
        deps.onBeforeExit?.();
        deps.app.exit(0);
      }
    })();
  });
}

export interface CoreServices {
  runtime: AppRuntime;
  watchdog: Watchdog;
  source: SignalSource;
  machineId: string;
  policy: Policy;
}

/**
 * Opens the database, resolves the machine id, creates the source and the
 * runtime, and arms the watchdog. Everything below this line in `index.ts`
 * reads its state.
 */
export async function createCoreServices(opts: {
  userDataDir: string;
  settings: SettingsStore;
  appVersion: string;
  isPackaged: boolean;
  tz?: string;
}): Promise<CoreServices> {
  const dbPath = defaultDbPath(opts.userDataDir);
  const policy = policyFromSettings(opts.settings);
  const db = openDb(dbPath, policy);

  let machineId = opts.settings.get("machineId");
  const platformUuid = readPlatformUuid();
  if (platformUuid !== null && platformUuid !== machineId) {
    machineId = platformUuid;
    await opts.settings.set("machineId", machineId);
  } else if (machineId === "") {
    // Non-Mac, or an unreadable ioreg. A persisted random id keeps this
    // machine's history coherent; minting a fresh one on every launch would
    // fork it, which is the failure this branch exists to avoid.
    machineId = randomUUID();
    await opts.settings.set("machineId", machineId);
    log.warn("IOPlatformUUID unavailable — using a persisted random machine id");
  }

  const source = await createSignalSource({ isPackaged: opts.isPackaged });

  const runtime = createRuntime({
    db,
    source,
    machineId,
    machineLabel: opts.settings.get("machineLabel"),
    appVersion: opts.appVersion,
    tz: opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    policy,
    dbPath,
    config: { idleTimeoutMs: opts.settings.get("idleTimeoutMin") * 60_000 },
  });

  const watchdog = createWatchdog({ source, target: runtime });

  return { runtime, watchdog, source, machineId, policy };
}

export function policyFromSettings(settings: SettingsStore): Policy {
  const s = settings.all();
  return {
    ...DEFAULT_POLICY,
    graceS: s.graceS,
    minIntervalS: s.minIntervalS,
    countJigglerTime: s.countJigglerTime === 1,
    levelStepH: s.heatmapThresholdsH[0],
  };
}
