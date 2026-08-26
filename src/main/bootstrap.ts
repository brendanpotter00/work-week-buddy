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
import type { SyncConfigState, SyncTestResult } from "../shared/ipc-types";
import { log } from "./log";
import { createMachineNaming, type MachineNaming } from "./device-name";
import { verifyLaunchAgent } from "./autostart";
import { readCodesign } from "./codesign";
import { createRuntime, type AppRuntime } from "./runtime";
import { readPlatformUuid } from "./machine-id";
import type { SettingsStore } from "./settings";
import {
  createSyncService,
  probeSyncConfig,
  resolveSyncConfig,
  type ConfigResult,
  type SyncService,
} from "./sync";
import { createTokenStore, type SecretVault, type TokenStore } from "./token";
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
  /** The wake half of the sync lifecycle: flush, pull, heartbeat, weekly pass. */
  sync?: Pick<SyncService, "runCycle"> | null;
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
      // The wake cycle is STARTED first and awaited last. An async function
      // runs its body synchronously up to the first `await`, so the cycle's
      // drain is already the in-flight one by the time `flushNow()` asks for
      // it — the two join a single flush and a single pull rather than
      // hitting the Worker twice for the same wake.
      const cycle = deps.sync?.runCycle("wake") ?? Promise.resolve();
      await deps.runtime.flushNow().catch(() => undefined);
      await cycle;
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
  /** Wired into the runtime as its `SyncSeam`. Unconfigured is a normal state. */
  sync: SyncService;
  /** Backs the two `wwb:sync:config:*` channels. */
  syncConfig: SyncConfigGateway;
  /** Backs `wwb:machine:rename`, and owns this Mac's row in `machine`. */
  naming: MachineNaming;
  /**
   * READS THE KEYCHAIN, AND THEREFORE NEVER RUNS DURING BOOT.
   *
   * `safeStorage.decryptString()` is synchronous and can put a SecurityAgent
   * dialog on screen — an app whose code identity has changed since the
   * keychain item was written gets one on every launch, and an ad-hoc signed
   * rebuild changes identity every time. macOS blocks the calling thread until
   * that dialog is answered, so on the boot path it is a dead event loop: no
   * window, no tray updates, no `second-instance`, no log line.
   *
   * `index.ts` calls this once the tray and the windows are already up. Then
   * the prompt arrives with a running app behind it, which is a question the
   * owner can answer instead of a hang he cannot diagnose.
   */
  unlockSync(): Promise<SyncUnlockResult>;
}

export interface SyncUnlockResult {
  /** How long the keychain took. Large means a human answered a dialog. */
  tookMs: number;
  configured: boolean;
  error: string | null;
}

export interface SyncConfigGateway {
  read(): SyncConfigState;
  write(patch: {
    workerUrl?: string;
    /**
     * The other address the same Worker answers on. Remembered, never synced
     * to — `resolveSyncConfig` does not look at it, and that is the point of
     * it: a second address is a diagnostic and a one-click fallback, not a
     * second thing the flusher has to reason about.
     *
     * `""` clears it, which is how a run that turned on only one address says
     * so; omitting it leaves whatever was there alone.
     */
    workerUrlAlt?: string;
    token?: string;
  }): Promise<SyncConfigState>;
  /**
   * Try a candidate configuration and store NOTHING.
   *
   * The whole point is that it runs before `write()`: a URL saved with a typo
   * reads as "not configured" forever, and a token saved into the wrong Mac
   * reads as a 401 that nobody sees because the flusher never surfaces one.
   * Either half may be omitted, and then the stored half is used — which is the
   * only way to re-test a token, since it cannot be read back to retype.
   */
  test(patch: { workerUrl?: string; token?: string }): Promise<SyncTestResult>;
}

/**
 * Reads and writes the two halves of the sync configuration, and keeps the
 * live service in step with them.
 *
 * The URL half is an ordinary setting. The token half never touches
 * `settings.json`, never leaves this process in readable form, and is reported
 * outwards only as the boolean `tokenPresent`.
 */
export function createSyncConfigGateway(deps: {
  settings: Pick<SettingsStore, "get" | "set">;
  tokens: TokenStore;
  sync: Pick<SyncService, "reconfigure">;
  /**
   * What `test()` reaches the Worker with. Production passes `appFetch`, so the
   * Test-connection button answers about the same network stack the flusher
   * uses — a button that succeeded where the flusher fails would be worse than
   * no button.
   */
  fetchImpl?: typeof fetch;
  /**
   * Fired after every successful `write()`, with the complete new state.
   *
   * This function is the SINGLE FUNNEL both paths already pass through — the
   * wizard's commit and the manual Save — which is what makes it the right
   * place to announce a change. It matters now because the wizard lives in its
   * own window: without a push, the Settings card in a different window would
   * go on saying "not set up" for the rest of the session. `index.ts` wires
   * this to `pushAll`.
   */
  onChange?: (state: SyncConfigState) => void;
}): SyncConfigGateway {
  const read = (): SyncConfigState => {
    const workerUrl = deps.settings.get("syncWorkerUrl");
    const token = deps.tokens.read();
    const resolved = resolveSyncConfig(workerUrl, token);
    return {
      workerUrl,
      workerUrlAlt: deps.settings.get("syncWorkerUrlAlt"),
      tokenPresent: token !== null,
      configured: resolved.config !== null,
      error: resolved.error,
      vaultAvailable: deps.tokens.available(),
    };
  };

  return {
    read,

    async test(patch) {
      // A pasted token arrives with whatever whitespace the clipboard carried —
      // a trailing newline out of a terminal is the usual one — and testing the
      // untrimmed string would fail against a token that is about to be stored
      // trimmed and work. `probeSyncConfig` trims both halves the same way
      // `write()` does, so the test and the save agree on what was entered.
      const workerUrl = patch.workerUrl ?? deps.settings.get("syncWorkerUrl");
      const token = patch.token ?? deps.tokens.read();
      return await probeSyncConfig(workerUrl, token, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        // The other address is tested at the same time, unauthenticated. It
        // cannot change the verdict either way — see `probeAlternate`.
        altUrl: deps.settings.get("syncWorkerUrlAlt"),
      });
    },

    async write(patch) {
      if (patch.workerUrl !== undefined) {
        await deps.settings.set("syncWorkerUrl", patch.workerUrl.trim());
      }
      // `""` clears it — that is how a run with no second address says so —
      // while omitting it leaves whatever was there alone. Swapping the two
      // addresses over is just this call with both halves set, so it goes
      // through the SAME funnel as every other change: `sync.reconfigure()`
      // runs, and every window hears about it.
      if (patch.workerUrlAlt !== undefined) {
        await deps.settings.set("syncWorkerUrlAlt", patch.workerUrlAlt.trim());
      }
      // Throws when there is no keychain to encrypt with, which surfaces in the
      // renderer as a rejected invoke. Storing it anywhere weaker is the one
      // outcome that is not available.
      if (patch.token !== undefined) deps.tokens.write(patch.token);
      const resolved = resolveSyncConfig(deps.settings.get("syncWorkerUrl"), deps.tokens.read());
      await deps.sync.reconfigure(resolved.config, resolved.error);
      const state = read();
      // After the reconfigure, so a window that reacts to this is reacting to a
      // service that is already live rather than to one that is about to be.
      deps.onChange?.(state);
      return state;
    },
  };
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
  /**
   * `--smoke`. The only thing that lets a PACKAGED build take the fake signal
   * source, and then only alongside two environment variables — see
   * `shouldUseFake` in `src/native/index.ts`.
   */
  isSmokeRun?: boolean;
  /**
   * Where the weekly export goes. Production leaves it undefined and takes the
   * iCloud-or-Documents answer; the smoke run points it inside its own
   * throwaway profile, because the one thing a test may not do is write to the
   * owner's iCloud Drive.
   */
  backupDir?: string;
  tz?: string;
  /**
   * Electron's `safeStorage`. Null on a system without one — and then no token
   * is stored at all, which reads as "not configured" rather than as a token
   * written somewhere weaker.
   */
  vault?: SecretVault | null;
  osVersion?: string;
  /**
   * Fired whenever the sync configuration changes, with the complete new state.
   *
   * Wired by `index.ts` to `pushAll("wwb:push:sync-config")`. It lives here
   * rather than being attached afterwards so there is no window in which a
   * write could land unannounced.
   */
  onSyncConfigChange?: (state: SyncConfigState) => void;
  /**
   * The outbound HTTP the sync layer uses.
   *
   * Passed IN rather than imported, so this file keeps its `import type` on
   * electron and its unit tests keep running in plain Node. `index.ts` supplies
   * `appFetch` — Chromium's stack, which reads the macOS proxy configuration
   * and the macOS trust store, neither of which Node's `fetch` does. Undefined
   * leaves the previous behaviour exactly as it was.
   */
  fetchImpl?: typeof fetch;
}): Promise<CoreServices> {
  const dbPath = defaultDbPath(opts.userDataDir);
  const policy = policyFromSettings(opts.settings);
  log.boot(`opening the database at ${dbPath}`);
  const db = openDb(dbPath, policy);
  log.boot("database open");

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

  log.boot("creating the signal source (loads koffi and the system frameworks)");
  const source = await createSignalSource({
    isPackaged: opts.isPackaged,
    ...(opts.isSmokeRun === undefined ? {} : { isSmokeRun: opts.isSmokeRun }),
  });
  log.boot("signal source ready");
  const tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // ── The sync layer, wired in ────────────────────────────────────────────
  // Built BEFORE the runtime because the runtime takes it as its seam, and
  // built unconditionally: an unconfigured service is a real object that
  // answers honestly, not a null that every call site has to remember.
  const tokens = createTokenStore(() => opts.userDataDir, opts.vault ?? null);
  // NOT `tokens.read()`. That call reaches the macOS Keychain, and the Keychain
  // answers a mismatched code identity with a modal dialog while holding the
  // calling thread. It hung the shipped app before a single window existed.
  // The service starts unconfigured — which is a state it already models
  // honestly — and `unlockSync()` below reconfigures it after the app is up.
  const resolved: ConfigResult = { config: null, error: null };
  let emitChange: (kind: "sync" | "rows-pulled") => void = () => undefined;
  // A thunk, not a string: a rename mid-session has to reach the next heartbeat.
  const currentLabel = (): string => opts.settings.get("machineLabel");
  const sync = createSyncService({
    db,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.backupDir === undefined ? {} : { backupDir: opts.backupDir }),
    config: resolved.config,
    configError: resolved.error,
    machineId,
    machineLabel: currentLabel,
    appVersion: opts.appVersion,
    ...(opts.osVersion === undefined ? {} : { osVersion: opts.osVersion }),
    tz,
    // A pull that brought rows in has to reach the tray and the dashboard, and
    // the runtime owns the only fan-out there is.
    onChange: (kind) => emitChange(kind),
  });

  // Before this call an install had NO row in `machine` at all — nothing wrote
  // one — so `byMachine`'s LEFT JOIN found nothing and every machine on the
  // dashboard rendered as a raw IOPlatformUUID. `init()` settles the default
  // name (macOS's own ComputerName) and writes the row.
  const naming = createMachineNaming({
    db,
    machineId,
    settings: opts.settings,
    appVersion: opts.appVersion,
    ...(opts.osVersion === undefined ? {} : { osVersion: opts.osVersion }),
    pushHeartbeat: async () => {
      await sync.heartbeatNow();
    },
  });
  log.boot("settling this Mac's name");
  await naming.init();
  log.boot("machine row written");

  const runtime = createRuntime({
    db,
    source,
    machineId,
    machineLabel: currentLabel,
    appVersion: opts.appVersion,
    isPackaged: opts.isPackaged,
    ...(opts.osVersion === undefined ? {} : { osVersion: opts.osVersion }),
    tz,
    policy,
    dbPath,
    config: { idleTimeoutMs: opts.settings.get("idleTimeoutMin") * 60_000 },
    sync,
    // The self-test's answer outlives the process that ran it, so the settings
    // pane can say WHEN it last passed rather than only that it can be run.
    selfTestStore: {
      read: () => opts.settings.get("lastSelfTest"),
      write: async (result) => {
        await opts.settings.set("lastSelfTest", result);
      },
    },
    // ── THE TWO IDENTITY READS ────────────────────────────────────────────
    // Passed as thunks, so nothing here runs until `doctor()` is called — and
    // `doctor()` is never on the boot path. Both shell out; neither can raise
    // a dialog; both are `execFile`, never `execFileSync`. See the headers of
    // `autostart.ts` and `codesign.ts`, and `afterBoot()` in `index.ts` for
    // the two freezes that made this paragraph necessary.
    autostart: () => verifyLaunchAgent(),
    codesign: () => readCodesign(),
  });
  emitChange = (kind) => {
    runtime.notifySync(kind);
  };

  // The log sink is wired here and not defaulted inside the watchdog so that a
  // tap that quietly went down and came back leaves a line in `wwb.log`. The
  // owner's diagnosis for this bug was five database rows and one stall
  // message; a recovery that happens silently is a recovery nobody can count.
  const watchdog = createWatchdog({
    source,
    target: runtime,
    log: (message) => log.info(message),
  });
  const syncConfig = createSyncConfigGateway({
    settings: opts.settings,
    tokens,
    sync,
    // The same stack the flusher will use. A Test-connection button that
    // answered about a different network layer than the one that actually
    // syncs would be worse than no button at all.
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSyncConfigChange === undefined
      ? {}
      : { onChange: opts.onSyncConfigChange }),
  });

  /** The keychain read, moved off the boot path. See `CoreServices.unlockSync`. */
  const unlockSync = async (): Promise<SyncUnlockResult> => {
    const startedMs = Date.now();
    let token: string | null = null;
    // NEVER ASK THE KEYCHAIN A QUESTION WHOSE ANSWER CANNOT MATTER.
    //
    // `resolveSyncConfig` returns "not configured" for an empty worker URL
    // whatever the token is, so on an install that has not turned sync on —
    // which is how the app ships and how most launches run — reading the token
    // buys nothing and risks a modal Keychain prompt on the main thread. The
    // cheapest way not to be blocked by a call is not to make it.
    const workerUrl = opts.settings.get("syncWorkerUrl").trim();
    try {
      if (workerUrl !== "") token = tokens.read();
    } catch (err) {
      // `read()` already swallows the ordinary failures; this is the last resort
      // so that a keychain that behaves in a way nobody predicted costs the
      // sync layer and nothing else.
      log.error("reading the sync token failed", err);
    }
    const tookMs = Date.now() - startedMs;
    const next = resolveSyncConfig(workerUrl, token);
    await sync.reconfigure(next.config, next.error);
    return { tookMs, configured: next.config !== null, error: next.error };
  };

  return { runtime, watchdog, source, machineId, policy, sync, syncConfig, naming, unlockSync };
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
