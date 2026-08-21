/**
 * The IPC contract — `docs/IMPL_UI.md` §2.4.
 *
 * Pure types and const literals. No `electron`, no node builtins, no imports at
 * all. Main, preload and renderer import this file and nothing else in common,
 * which is what makes "the renderer never touches the database" a structural
 * fact rather than a convention.
 *
 * Three rules the shapes below encode:
 *
 * 1. Every timestamp on the wire is ABSOLUTE epoch ms. Never a duration, never
 *    a pre-formatted string. A duration cannot survive sleep, and a formatted
 *    string cannot be recomputed after a collapsed timer.
 * 2. Every push payload is a COMPLETE snapshot. Deltas need ordering guarantees
 *    IPC does not give you.
 * 3. `number | null` everywhere a metric can be absent. `—` means "no data",
 *    `0` means "zero hours", and they are different pixels. PRD §4.
 */

export type MachineId = string;
/** 'YYYY-MM-DD', in the row's own local zone. Never UTC. */
export type LocalDate = string;

/**
 * Mirrors `EndReason` in `src/core/types.ts`, which is the authority: those are
 * the only values `reduce()` can produce and therefore the only values that can
 * reach a row. `docs/IMPL_UI.md` §2.4 also lists `sleep`, `lock`, `shutdown`
 * and `paused`; the committed reducer emits none of them, so they are not here.
 * `src/shared/ipc-types.test.ts` asserts the two stay in step.
 */
export type EndReason =
  | "idle_timeout"
  | "camera_cap"
  | "jiggler_toggle"
  | "pause"
  | "app_quit"
  | "tap_lost"
  | "crash_recovered";

// ── live status ─────────────────────────────────────────────────────────────

export type TrackingState = "working" | "idle" | "paused";
export type SignalKind = "input" | "camera" | "mic";

/**
 * What can hold an interval open WITHOUT a person: a camera or a live mic.
 *
 * `docs/IMPL_UI.md` §2.4 types `heldOpenBy` as `SignalKind | null`, which is
 * wider than anything that can occur — `runtime.heldBy()` returns `camera`,
 * `mic` or `null` and there is no fourth answer. "Held open by input" is not a
 * state: input IS the person, and an interval the person is feeding is simply
 * open, never held. The same reasoning `EndReason` gets above applies here —
 * a wire type wider than reality teaches the renderer to branch on states that
 * never happen, and the branch it grows is dead copy nobody can ever read.
 *
 * `src/shared/ipc-types.test.ts` pins this to what `heldBy()` can return.
 */
export type HoldKind = Exclude<SignalKind, "input">;

export type DegradedReason =
  /** the granted mask lost the keyboard bits — typing is invisible, silently */
  | "keyboard_permission_missing"
  /** the jiggler cannot post. Tracking is unaffected. */
  | "accessibility_missing"
  /** the watchdog found the tap dead */
  | "tap_lost"
  /** a grant landed but the live tap still lacks the bits */
  | "relaunch_required"
  /** DATA_MODEL backup layer 4 */
  | "sync_silent_72h"
  /** backup layer 3 */
  | "fingerprint_mismatch"
  | "db_unwritable"
  /**
   * The jiggler self-test did not pass, so the jiggler was switched back off.
   *
   * This is the only reason on this list that means an hours figure ALREADY
   * WRITTEN might be too large: a broken ours-vs-theirs discriminator counts
   * our own synthetic input as a person. AGENTS.md trap #4.
   */
  | "selftest_failed";

export interface LiveStatus {
  asOfMs: number;
  state: TrackingState;
  /** first real signal of the open interval; null when idle */
  openedAtMs: number | null;
  /** most recent signal of ANY kind that is not our own jiggle; null before the first */
  lastSignalMs: number | null;
  lastSignalKind: SignalKind | null;
  /** absolute epoch ms. DISPLAY ONLY — no renderer may schedule from this. */
  deadlineMs: number | null;
  /** non-null while a camera/mic level is holding the interval open */
  heldOpenBy: HoldKind | null;
  /** absolute epoch ms the hold is capped at (PRD §3.4), null when uncapped */
  heldUntilMs: number | null;
  cameraOn: boolean;
  micCapturing: boolean;
  machineId: MachineId;
  machineLabel: string;
  /** closed, countable hours this local week. EXCLUDES the open interval. */
  closedHoursThisWeek: number | null;
  closedHoursToday: number | null;
  jigglerOnForOpenInterval: boolean;
  degraded: DegradedReason[];
}

// ── toggles ─────────────────────────────────────────────────────────────────

export interface Toggles {
  jiggler: boolean;
  keepAwake: boolean;
  paused: boolean;
  /** false ⇒ the jiggler switch must render DISABLED with a reason, never merely unchecked */
  jigglerAvailable: boolean;
  jigglerUnavailableReason: string | null;
}

export type ToggleKey = "jiggler" | "keepAwake" | "paused";

export interface ToggleChange {
  key: ToggleKey;
  value: boolean;
  source: "tray" | "dashboard";
}

// ── permissions ─────────────────────────────────────────────────────────────

export type PermissionKey = "inputMonitoring" | "accessibility";
export type PermissionState = "granted" | "denied" | "undetermined" | "unknown";

export interface PermissionSnapshot {
  checkedAtMs: number;
  inputMonitoring: PermissionState;
  accessibility: PermissionState;
  /**
   * THE AUTHORITY. `docs/MACOS.md` §6: which TCC bucket governs the keyboard
   * bits is disputed, so neither preflight is trusted — the granted mask is
   * read back off the live tap and believed.
   */
  keyboardBitsGranted: boolean;
  flagsChangedBitGranted: boolean;
  /** hex, never a BigInt: BigInt is not JSON-serialisable and dies crossing IPC */
  grantedMaskHex: string;
  /** a grant landed but the live tap still lacks the bits ⇒ restart required */
  relaunchRequired: boolean;
  /** true once the system prompt for that key has been consumed (one shot, ever) */
  promptConsumed: Record<PermissionKey, boolean>;
  /** M1 gate (g). 'prompted' is a defect, not a state to design for. */
  microphone: "not-required" | "prompted";
}

// ── metrics ─────────────────────────────────────────────────────────────────

export interface MetricsPolicy {
  /** `v_countable` stray-bump floor, default 90 */
  minIntervalS: number;
  /** `v_countable`, PRD D1, default 0 */
  countJigglerTime: 0 | 1;
  /** `v_countable`, default 0 */
  graceS: number;
  heatmapThresholdsH: [number, number, number];
}

export interface HeatmapDay {
  date: LocalDate;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface WeekBar {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  date: LocalDate;
  hours: number;
}

export interface MachineBreakdown {
  machineId: MachineId;
  label: string;
  hours: number;
  intervals: number;
  meetingHours: number;
  jigglerHours: number;
  /** hours ÷ Σ hours, computed in main so the renderer stays arithmetic-free */
  share: number;
  lastSeenMs: number | null;
}

export interface MetricsBundle {
  generatedAtMs: number;
  policy: MetricsPolicy;
  weekStart: LocalDate;
  /** DATA_MODEL query 1 */
  week: { hours: number | null; prevHours: number | null };
  /** query 2 */
  interval: { avgMin: number | null; nIntervals: number };
  allTime: {
    avgMin: number | null;
    nIntervals: number;
    hoursTracked: number | null;
    sinceDate: LocalDate | null;
  };
  /** query 3 */
  longest: {
    singleHours: number | null;
    singleMachineLabel: string | null;
    singleDate: LocalDate | null;
    mergedHours: number | null;
    mergedDate: LocalDate | null;
  };
  /** query 4, 371 days */
  heatmap: HeatmapDay[];
  /** 7 rows, Mon-first, zero-filled */
  weekBars: WeekBar[];
  /** query 5 */
  byMachine: MachineBreakdown[];
  /** query 6, today */
  honesty: { date: LocalDate; naiveSumH: number | null; unionH: number | null };
}

// ── sync / doctor ───────────────────────────────────────────────────────────

export interface FlushResult {
  ok: boolean;
  attempted: number;
  confirmed: number;
  pendingAfter: number;
  error: string | null;
  atMs: number;
}

export interface TapHealth {
  created: boolean;
  enabled: boolean;
  /** "-" when this process has no tap at all — NOT "0x0", which reads as denied. */
  grantedMaskHex: string;
  keyboardBitsPresent: boolean;
  flagsChangedBitPresent: boolean;
  /**
   * False when nothing has probed the tap in this process — `--doctor` never
   * installs one. Without this flag the two mask fields above are indelibly
   * ambiguous: "denied" and "never asked" look identical.
   */
  probed: boolean;
  runLoopModes: Array<"default" | "common">;
  eventsSinceLaunch: number;
  lastEventMs: number | null;
  disabledByTimeoutCount: number;
  disabledByUserInputCount: number;
  /** Re-enables issued from the disable-notice callback. */
  reEnabledCount: number;
  /** Of those, the ones that did not take. Non-zero is a real finding. */
  reEnableFailedCount: number;
  /** Times the liveness beat found the tap off and put it back, unaided. */
  revivedCount: number;
  lastRevivalMs: number | null;
  lastRevivalOutcome: string | null;
  /** Drains that ran >50 ms late — the main thread was starved. */
  drainsOverdue: number;
  worstDrainLagMs: number;
  tapLostRows: number;
  lastWatchdogTickMs: number | null;
}

export interface SelfTestResult {
  ranAtMs: number;
  passed: boolean;
  appVersion: string;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface DoctorReport {
  generatedAtMs: number;
  allGreen: boolean;
  app: {
    version: string;
    electron: string;
    bundleId: string;
    execPath: string;
    isPackaged: boolean;
    launchedAtMs: number;
  };
  machine: { machineId: MachineId; label: string; osVersion: string; tz: string };
  permissions: PermissionSnapshot;
  tap: TapHealth;
  camera: {
    deviceCount: number;
    inUse: boolean;
    listenerRegistered: boolean;
    lastReadMs: number | null;
  };
  mic: {
    inUse: boolean;
    needsPermission: boolean | null;
  };
  sync: {
    /**
     * THREE STATES, NOT TWO. False means no Worker URL and no token — which is
     * neither healthy nor failing, and must not be painted as either. Every
     * timestamp below is null in that state and none of them is a problem.
     */
    configured: boolean;
    pendingRows: number;
    lastFlushOkMs: number | null;
    lastFlushError: string | null;
    lastPullMs: number | null;
    /** A pull can fail while the flush that preceded it succeeded. Separate field, separate truth. */
    lastPullError: string | null;
    watermark: number;
    lastCloudWriteMs: number | null;
    silentForMs: number | null;
  };
  fingerprint: {
    checkedAtMs: number | null;
    matched: boolean | null;
    localCount: number | null;
    cloudCount: number | null;
    localSha: string | null;
    cloudSha: string | null;
  };
  backup: {
    lastPath: string | null;
    lastAtMs: number | null;
    ageDays: number | null;
    destination: "icloud" | "documents" | null;
    kept: number;
  };
  selfTest: SelfTestResult | null;
  db: {
    path: string;
    sizeBytes: number;
    rows: number;
    openIntervalPresent: boolean;
    integrityOk: boolean;
  };
  autostart: {
    installed: boolean;
    loaded: boolean;
    plistPath: string;
    execMatchesRunningApp: boolean;
  };
  codesign: { designatedRequirementSha256: string | null; valid: boolean | null };
}

export interface AppInfo {
  version: string;
  machineId: MachineId;
  machineLabel: string;
  tz: string;
  isPackaged: boolean;
  idleTimeoutMin: number;
}

export interface UiSettings {
  machineLabel: string;
  idleTimeoutMin: number;
  windowBackground: string;
  heatmapThresholdsH: [number, number, number];
  minIntervalS: number;
  countJigglerTime: 0 | 1;
  graceS: number;
  /**
   * The Worker's base URL, e.g. `https://wwb-sync.<account>.workers.dev`. An
   * ordinary setting in `settings.json`: a URL is not a credential.
   *
   * Its other half, the bearer token, is NOT here and never crosses this
   * boundary in either direction. It lives in Electron `safeStorage`, and the
   * renderer may only write it (`wwb:sync:setConfig`) or ask whether one
   * exists (`SyncConfigState.tokenPresent`).
   */
  syncWorkerUrl: string;
}

/**
 * Enough for a settings pane to render the sync section honestly, and not one
 * byte more. `tokenPresent` rather than the token: a secret that reaches the
 * renderer is a secret in a devtools console, in a heap snapshot, and in
 * whatever an extension can read.
 */
export interface SyncConfigState {
  workerUrl: string;
  tokenPresent: boolean;
  /** Both halves present and usable. This is the `configured` in the doctor. */
  configured: boolean;
  /** Why a URL or token that IS set is nonetheless unusable. */
  error: string | null;
  /** False when this system has no keychain, so no token can be stored at all. */
  vaultAvailable: boolean;
}

/**
 * The answer to "does this URL and this token actually work", BEFORE either is
 * saved.
 *
 * Two booleans and not one, because the two failures need different fixes and
 * the owner cannot tell them apart from a single "it didn't work":
 *
 *  - `reachable` is `GET /health`, which is unauthenticated on purpose
 *    (`worker/src/routes.ts`). False means the URL is wrong, the Worker is not
 *    deployed, or — the case this whole probe exists for — the work Mac's proxy
 *    is blocking `workers.dev`.
 *  - `authorized` is an authenticated read on the same host. False with
 *    `reachable: true` means the Worker is fine and the TOKEN is wrong, which
 *    is the one diagnosis a URL-only check can never produce.
 *
 * It carries no token and no response body: a probe that echoed either would
 * put the secret in the renderer, which is the single thing this boundary
 * exists to prevent.
 */
export interface SyncTestResult {
  /** Reachable AND authorized. Anything else is a failure with a reason. */
  ok: boolean;
  reachable: boolean;
  authorized: boolean;
  /** The HTTP status that decided it, when there was one. */
  status: number | null;
  /** Round trip in ms, so "it works but it is slow" is visible. */
  ms: number | null;
  /** Plain words. Never a token, never a raw response body. */
  error: string | null;
}

// ── the contract ────────────────────────────────────────────────────────────

export interface InvokeContract {
  "wwb:app:info": { req: void; res: AppInfo };
  "wwb:status:get": { req: void; res: LiveStatus };
  "wwb:metrics:get": { req: MetricsPolicy; res: MetricsBundle };
  "wwb:toggles:get": { req: void; res: Toggles };
  "wwb:toggles:set": { req: ToggleChange; res: Toggles };
  "wwb:permissions:get": { req: void; res: PermissionSnapshot };
  "wwb:permissions:refresh": { req: void; res: PermissionSnapshot };
  "wwb:permissions:request": { req: PermissionKey; res: PermissionSnapshot };
  "wwb:permissions:openSettings": { req: PermissionKey; res: void };
  "wwb:permissions:relaunch": { req: void; res: void };
  "wwb:onboarding:dismiss": { req: void; res: void };
  "wwb:doctor:get": { req: void; res: DoctorReport };
  "wwb:doctor:selftest": { req: void; res: SelfTestResult };
  "wwb:sync:flush": { req: void; res: FlushResult };
  "wwb:sync:config": { req: void; res: SyncConfigState };
  /** Either half may be omitted. The token is write-only; it never comes back. */
  "wwb:sync:setConfig": {
    req: { workerUrl?: string; token?: string };
    res: SyncConfigState;
  };
  /**
   * Try a candidate configuration WITHOUT storing it.
   *
   * The request has the same shape as `setConfig` and the same one-way rule: a
   * token may go in and never comes back. Omit either half and the stored one
   * is used, so "re-test what is saved" needs no retyping — and re-testing is
   * the common case, since the token cannot be read back to retype.
   */
  "wwb:sync:test": { req: { workerUrl?: string; token?: string }; res: SyncTestResult };
  "wwb:machine:rename": { req: { label: string }; res: AppInfo };
  "wwb:settings:get": { req: void; res: UiSettings };
  "wwb:settings:set": { req: Partial<UiSettings>; res: UiSettings };
  "wwb:window:openDashboard": { req: void; res: void };
  /**
   * Settings is its own window (`ROUTE.settings`), so the dashboard reaches it
   * the same way the tray does — by asking main to open it — rather than by
   * navigating itself and losing the dashboard.
   */
  "wwb:window:openSettings": { req: void; res: void };
  /**
   * Double-click on the title bar — zoom, the way every macOS title bar does.
   *
   * It is wired by hand because a `-webkit-app-region: drag` region gets NO
   * double-click behaviour from macOS. Measured on Electron 43 against a
   * `hiddenInset` window: a double-click anywhere in the drag region, and a
   * double-click in the top 28 px where the native title bar would be, both do
   * nothing — `fullSizeContentView` means the web contents own every pixel, so
   * there is no title bar left for AppKit to act on. A no-op on a window that
   * is not maximizable (onboarding is a fixed box).
   */
  "wwb:window:zoom": { req: void; res: void };
}

export interface PushContract {
  "wwb:push:status": LiveStatus;
  "wwb:push:toggles": Toggles;
  "wwb:push:permissions": PermissionSnapshot;
  "wwb:push:metrics-stale": { reason: "interval-close" | "rows-pulled" };
  "wwb:push:doctor": DoctorReport;
}

export type InvokeChannel = keyof InvokeContract;
export type PushChannel = keyof PushContract;

/** The preload allowlist. A channel not in these arrays cannot cross the bridge. */
export const INVOKE_CHANNELS = [
  "wwb:app:info",
  "wwb:status:get",
  "wwb:metrics:get",
  "wwb:toggles:get",
  "wwb:toggles:set",
  "wwb:permissions:get",
  "wwb:permissions:refresh",
  "wwb:permissions:request",
  "wwb:permissions:openSettings",
  "wwb:permissions:relaunch",
  "wwb:onboarding:dismiss",
  "wwb:doctor:get",
  "wwb:doctor:selftest",
  "wwb:sync:flush",
  "wwb:sync:config",
  "wwb:sync:setConfig",
  "wwb:sync:test",
  "wwb:machine:rename",
  "wwb:settings:get",
  "wwb:settings:set",
  "wwb:window:openDashboard",
  "wwb:window:openSettings",
  "wwb:window:zoom",
] as const satisfies readonly InvokeChannel[];

export const PUSH_CHANNELS = [
  "wwb:push:status",
  "wwb:push:toggles",
  "wwb:push:permissions",
  "wwb:push:metrics-stale",
  "wwb:push:doctor",
] as const satisfies readonly PushChannel[];

export const DEFAULT_METRICS_POLICY: MetricsPolicy = {
  minIntervalS: 90,
  countJigglerTime: 0,
  graceS: 0,
  heatmapThresholdsH: [2, 5, 8],
};
