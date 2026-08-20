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
 * What can hold an interval open WITHOUT a person: a camera or a meeting mic.
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
  | "db_unwritable";

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
  meetingAppRunning: boolean;
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
  grantedMaskHex: string;
  keyboardBitsPresent: boolean;
  flagsChangedBitPresent: boolean;
  runLoopModes: Array<"default" | "common">;
  eventsSinceLaunch: number;
  lastEventMs: number | null;
  disabledByTimeoutCount: number;
  reEnabledCount: number;
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
    meetingAppRunning: boolean;
    meetingApp: string | null;
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
  meetingApps: string[];
  micIgnoreApps: string[];
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
  "wwb:machine:rename": { req: { label: string }; res: AppInfo };
  "wwb:settings:get": { req: void; res: UiSettings };
  "wwb:settings:set": { req: Partial<UiSettings>; res: UiSettings };
  "wwb:window:openDashboard": { req: void; res: void };
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
  "wwb:machine:rename",
  "wwb:settings:get",
  "wwb:settings:set",
  "wwb:window:openDashboard",
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
