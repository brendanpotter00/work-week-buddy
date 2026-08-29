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
  /**
   * Query 1, over ONE local day instead of a week — the same `v_merged_day`
   * union, so two Macs awake at once count as one hour and not two.
   *
   * `hours` EXCLUDES the interval that is open right now, exactly as
   * `week.hours` does: a `MetricsBundle` is what the database holds. The open
   * interval is added on the way to the screen by `hoursToday()` in
   * `src/shared/format.ts`, which is the one function the tray title, the tray
   * menu, the stopwatch card and the Today stat card all go through — which is
   * why those four figures cannot disagree.
   *
   * `date` is the local day `hours` is for, in the display timezone, and it is
   * what makes the midnight rollover visible on the wire rather than implied.
   * `prevHours` is the day before it: the Today card's delta baseline, and
   * necessarily a closed figure because yesterday has no open interval.
   */
  today: { date: LocalDate; hours: number | null; prevHours: number | null };
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

/**
 * Will this Mac start the app at login, and will it start THIS copy of it?
 *
 * The wire shape lives here rather than in `src/main/autostart.ts` because the
 * renderer's Doctor panel reads it and `src/shared/` may not import from
 * `src/main/`. The producer is `verifyLaunchAgent()`; the reasoning for every
 * field is in that file's header.
 */
export interface AutostartState {
  /** False means nothing below was looked at — not that the answer is "no". */
  probed: boolean;
  installed: boolean;
  loaded: boolean;
  plistPath: string;
  /** ProgramArguments[0] as the plist has it. */
  execPath: string | null;
  /** Does that program still exist? False is a plist pointing into thin air. */
  execExists: boolean;
  execMatchesRunningApp: boolean;
}

/**
 * The bundle's code identity — what every TCC grant is really bound to.
 * Produced by `readCodesign()`; see `src/main/codesign.ts`.
 */
export interface CodesignState {
  probed: boolean;
  /** SHA-256 of the designated requirement. Hashed: this repository is public. */
  designatedRequirementSha256: string | null;
  valid: boolean | null;
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
    /**
     * Did anything actually read the camera in this process?
     *
     * This replaces `listenerRegistered`, which was a field that could never be
     * true: `native.ts` registers no CMIO property listener anywhere, on
     * purpose — the HAL delivers them on its own thread and a koffi callback
     * invoked off the JS thread is a crash, not a latency problem. The runtime
     * was answering it with `status !== null`, which is "probed", so the field
     * has been renamed to what it was already measuring. Same story as
     * `tap.probed` (AGENTS.md silent-failure #16).
     */
    probed: boolean;
    /**
     * Video devices CoreMediaIO can see. Null when `probed` is false — NOT 0.
     * Zero devices on a Mac that has cameras is the App Sandbox failure
     * (AGENTS.md #12), and it must not be indistinguishable from "did not look".
     */
    deviceCount: number | null;
    inUse: boolean;
    lastReadMs: number | null;
  };
  mic: {
    inUse: boolean;
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
    /** `page_count * page_size` — the database, not the directory. */
    sizeBytes: number;
    rows: number;
    openIntervalPresent: boolean;
    integrityOk: boolean;
  };
  autostart: AutostartState;
  codesign: CodesignState;
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
  /**
   * The OTHER address the Worker answers on, when setup turned two on.
   *
   * NEVER USED TO SYNC. It exists so Settings can test both and offer to switch
   * in one click when the one in use stops answering — so a Mac that lands on
   * the wrong address is a click away from the right one rather than a re-run
   * of setup. A URL, like `syncWorkerUrl`, and equally not a credential.
   */
  syncWorkerUrlAlt: string;
}

/**
 * Enough for a settings pane to render the sync section honestly, and not one
 * byte more. `tokenPresent` rather than the token: a secret that reaches the
 * renderer is a secret in a devtools console, in a heap snapshot, and in
 * whatever an extension can read.
 */
export interface SyncConfigState {
  workerUrl: string;
  /** The other address setup turned on, or "". Never used to sync. */
  workerUrlAlt: string;
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
  /**
   * The same question asked of the OTHER address, when there is one.
   *
   * `/health` ONLY — unauthenticated. The token has already been proved against
   * the address in use, and it is a property of the Worker rather than of the
   * hostname, so asking twice buys nothing and costs a second authenticated
   * round trip on a button somebody is waiting on.
   *
   * Null when no alternate is configured, which is the ordinary case.
   */
  alt: {
    url: string;
    reachable: boolean;
    status: number | null;
    ms: number | null;
    error: string | null;
  } | null;
}

// ── in-app cloud setup ──────────────────────────────────────────────────────

export type CloudStepId =
  | "token"
  | "account"
  | "database"
  | "schema"
  | "enrol"
  | "deploy"
  | "url"
  | "verify"
  | "save";

export interface CloudStep {
  id: CloudStepId;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  /** One short line for the row. Plain words — never a token, never a body. */
  detail: string | null;
}

/**
 * How far setup has got. A COMPLETE snapshot every time, like every other push
 * in this contract: a wizard that missed one delta would show a step stuck on
 * "running" for the rest of the session.
 */
export interface CloudSetupProgress {
  steps: CloudStep[];
  done: boolean;
  error: string | null;
}

/** Whether one permission is present, absent, or could not be determined. */
export type CloudScopeState = "ok" | "missing" | "unknown";

/**
 * What the pasted API token is actually allowed to do.
 *
 * Discovered by trying, because there is no way to ask: `/user/tokens/verify`
 * returns only `{id, status}`, and the endpoints that DO return a token's
 * permissions all require `API Tokens Read` — which this app must never
 * request, since it would let the app read the user's other tokens.
 *
 * A read probe proves Read, not Edit. This catches "no D1 permission at all",
 * which is the failure that was actually observed; a Read-only token is caught
 * at the first write and named correctly there.
 */
export interface CloudScopes {
  d1: CloudScopeState;
  workers: CloudScopeState;
  /** Optional — it only decides whether setup can list accounts. */
  accountRead: CloudScopeState;
  /**
   * Optional, and it decides less than it looks like it does: whether the
   * review screen shows a DOMAIN PICKER or a text field. Attaching a custom
   * domain is authorised by Workers Scripts, which is already required.
   */
  zones: CloudScopeState;
}

/** One Mac already in the registry. */
export interface EnrolledMachine {
  machineId: string;
  /** Null until that Mac's first heartbeat reaches the cloud. */
  label: string | null;
  enrolledAtMs: number;
  lastSeenMs: number | null;
  /** True when this row is the Mac the wizard is running on. */
  isThisMac: boolean;
}

/**
 * What is already on the account, read before anything is changed.
 *
 * `accountSubdomain: null` is the one thing here the owner has to answer: a
 * workers.dev subdomain is account-wide and shows up in the address of
 * everything they deploy, so setup will not invent one.
 */
export interface CloudDeployment {
  accountId: string;
  databaseExists: boolean;
  workerExists: boolean;
  /**
   * The Macs already enrolled, so the review screen can show what exists
   * rather than make the owner guess. Empty before the first enrolment.
   */
  machines: EnrolledMachine[];
  accountSubdomain: string | null;
  rowsInCloud: number | null;
  /**
   * The domains on this account, for the address picker.
   *
   * EMPTY MEANS TWO THINGS and `CloudScopes.zones` separates them: `ok` with an
   * empty list is an account with no domains on it; `missing` is a token that
   * may not look. The screen says something different for each.
   */
  zones: Array<{ id: string; name: string }>;
  /**
   * Hostnames already pointed at a Worker on this account, and which Worker.
   * Lets the review screen refuse a name that belongs to something else before
   * anything is created.
   */
  workerDomains: Array<{ hostname: string; service: string }>;
}

/**
 * The answer to "what would setup be working with", before it does anything.
 *
 * `accounts` is empty when the token is fine but may not enumerate accounts —
 * Cloudflare documents `GET /accounts` for API keys rather than tokens — and
 * then the pane asks for the account id instead of reporting a failure.
 */
export interface CloudProbeResult {
  tokenValid: boolean;
  tokenStatus: string;
  accounts: Array<{ id: string; name: string }>;
  /** Null until an account has been chosen. */
  scopes: CloudScopes | null;
  /**
   * Null when there is no account yet, when the probe failed — and, notably,
   * when a permission is missing: inspecting a deployment the token may not
   * read is pointless, and `scopes` is what the screen renders instead.
   */
  deployment: CloudDeployment | null;
  error: string | null;
}

/** One address setup turned on, and what it did when THIS Mac asked it. */
export interface CloudAddressProbe {
  url: string;
  kind: "workers.dev" | "custom";
  reachable: boolean;
  /** Null when reachable. Plain words — never a token, never a response body. */
  error: string | null;
  ms: number | null;
}

export interface CloudSetupResult extends CloudSetupProgress {
  ok: boolean;
  workerUrl: string | null;
  /**
   * EVERY address, and what each one did from this Mac. Present on failure too:
   * a run that could not reach anything is exactly when this is worth most.
   */
  addresses: CloudAddressProbe[];
  /** The other live address. Diagnostics and a one-click switch; never synced to. */
  altWorkerUrl: string | null;
  /**
   * This Mac's token, surfaced ONLY when the keychain refused to store it.
   *
   * The one secret that ever crosses this boundary outwards, and the only token
   * this app ever renders. Nothing is minted for any other machine — each Mac
   * enrols itself — so there is nothing to carry anywhere.
   */
  unstoredToken: string | null;
}

/**
 * The two halves of a setup run. The API token rides in and is never persisted,
 * never logged, and never comes back — `CloudProbeResult` and
 * `CloudSetupResult` have no field one could return on.
 */
export interface CloudProbeRequest {
  apiToken: string;
  /** Omitted on the first probe; supplied once an account has been chosen. */
  accountId?: string;
}

/** The second address, as the review screen collected it. */
export interface CloudCustomDomainRequest {
  /** One DNS label, e.g. `wwb`. Never a full hostname. */
  label: string;
  /**
   * By id when setup could list the domains, by name when it could not. The
   * by-name form is what makes `Zone · Read` optional.
   */
  zone: { id: string; name: string } | { name: string };
}

export interface CloudSetupRunRequest {
  apiToken: string;
  accountId: string;
  /** Only used when the account has no workers.dev subdomain at all. */
  subdomain?: string;
  /**
   * Also put the Worker on a domain the owner already has. ADDITIVE — the
   * workers.dev address is turned on either way and never switched off.
   */
  customDomain?: CloudCustomDomainRequest;
}

/**
 * Stop one Mac syncing. Requires the API token, i.e. the wizard.
 *
 * There is deliberately no Worker route for this: one would let a stolen bearer
 * token take every other Mac offline. Nothing already recorded is deleted.
 */
export interface CloudRevokeRequest {
  apiToken: string;
  accountId: string;
  machineId: string;
}

export interface CloudRevokeResult {
  ok: boolean;
  /** The registry as it stands afterwards, so the screen never has to guess. */
  machines: EnrolledMachine[];
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
  // `wwb:doctor:selftest` was removed with the Settings self-test card (#29).
  // The self-test itself is very much alive — `--selftest` is install.sh's hard
  // gate, and `runtime.selfTest()` runs whenever the jiggler is switched on —
  // but nothing in the renderer had called this channel since that card went,
  // and a declared channel with no caller is reachable surface nobody reviews.
  // `doctor.selfTest` in the report is where the last result is read from now.
  "wwb:sync:flush": { req: void; res: FlushResult };
  "wwb:sync:config": { req: void; res: SyncConfigState };
  /** Either half may be omitted. The token is write-only; it never comes back. */
  "wwb:sync:setConfig": {
    /**
     * `workerUrlAlt` is how the two addresses are SWAPPED — send both, with the
     * values exchanged. Deliberately not a channel of its own: a swap is an
     * ordinary configuration change and must go through the one funnel that
     * rebuilds the flusher and tells every window.
     */
    req: { workerUrl?: string; workerUrlAlt?: string; token?: string };
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
  /**
   * Look at a Cloudflare account and change NOTHING.
   *
   * Runs before the wizard offers to do anything, so the confirmation screen
   * describes what is really there — an existing `wwb` database, an existing
   * Worker, the other Mac's token — instead of what setup intends. A probe that
   * created something would make "Cancel" a lie.
   */
  "wwb:cloud:probe": { req: CloudProbeRequest; res: CloudProbeResult };
  /**
   * Do it. Resolves with the finished run; progress arrives meanwhile on
   * `wwb:push:cloud-setup`, so nothing about this waits on the UI or vice versa.
   */
  "wwb:cloud:run": { req: CloudSetupRunRequest; res: CloudSetupResult };
  /**
   * Revoke one Mac's token. Never throws at the renderer — the result carries
   * the reason, because the caller is a button.
   */
  "wwb:cloud:revoke": { req: CloudRevokeRequest; res: CloudRevokeResult };
  /**
   * Open Cloudflare's API-token page in the real browser.
   *
   * It has to be an IPC channel rather than an `<a href>`: `lockDownNavigation`
   * preventDefaults any non-app origin on `will-navigate`, so a plain link is
   * inert. Takes no argument — the URL is built in main from
   * `src/cloud/token-url.ts` so a renderer can never choose where this goes.
   */
  "wwb:cloud:openTokenPage": { req: void; res: void };
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
   * Open the cloud-setup wizard window.
   *
   * The wizard is a TASK, not a setting, so it has its own window — and the
   * tray can therefore open it directly. A setup flow reachable only by finding
   * Settings and scrolling to a card is a setup flow that does not get run.
   */
  "wwb:window:openCloudSetup": { req: void; res: void };
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
  /** Cloud setup progress, a complete snapshot per step. See `CloudSetupProgress`. */
  "wwb:push:cloud-setup": CloudSetupProgress;
  /**
   * Sync configuration changed. A COMPLETE snapshot, like every other push here.
   *
   * The wizard lives in its own window now, so it cannot reload the Settings
   * card in place the way the in-card version could. Rather than re-read on
   * focus — fragile, and stale in the common case where both windows are
   * visible at once — the single funnel every write already passes through
   * (`SyncConfigGateway.write`) pushes. That makes the manual Save path push
   * too, so the dashboard updates without a reload either.
   */
  "wwb:push:sync-config": SyncConfigState;
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
  "wwb:sync:flush",
  "wwb:sync:config",
  "wwb:sync:setConfig",
  "wwb:sync:test",
  "wwb:cloud:probe",
  "wwb:cloud:run",
  "wwb:cloud:revoke",
  "wwb:cloud:openTokenPage",
  "wwb:machine:rename",
  "wwb:settings:get",
  "wwb:settings:set",
  "wwb:window:openDashboard",
  "wwb:window:openSettings",
  "wwb:window:openCloudSetup",
  "wwb:window:zoom",
] as const satisfies readonly InvokeChannel[];

export const PUSH_CHANNELS = [
  "wwb:push:status",
  "wwb:push:toggles",
  "wwb:push:permissions",
  "wwb:push:metrics-stale",
  "wwb:push:doctor",
  "wwb:push:cloud-setup",
  "wwb:push:sync-config",
] as const satisfies readonly PushChannel[];

export const DEFAULT_METRICS_POLICY: MetricsPolicy = {
  minIntervalS: 90,
  countJigglerTime: 0,
  graceS: 0,
  heatmapThresholdsH: [2, 5, 8],
};
