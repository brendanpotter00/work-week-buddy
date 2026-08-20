/**
 * The seam. `SignalSource` → `reduce()` → effects → the store.
 *
 * This is the only place those three meet, and it is deliberately free of
 * `electron`: the tray, the IPC layer and `index.ts` talk to it through the
 * `AppRuntime` interface, and the tests drive it with the fake `SignalSource`
 * and an in-memory database. No permission grant, no Mac, no waiting.
 *
 * THE RULES THIS FILE EXISTS TO KEEP
 *
 * 1. **Every state change goes through `reduce()`.** There is no other mutation
 *    of `TrackerState` in the codebase. In particular the jiggler toggle is
 *    dispatched as a signal, so the interval boundary in the reducer actually
 *    happens rather than being reimplemented (badly) here.
 * 2. **An interval ends at the last real signal.** Nothing here ever passes
 *    `now()` as an `atMs`. Signals carry the hardware timestamp they came with.
 * 3. **The 15-minute deadline lives here, in main, as an absolute epoch ms.**
 *    `deadline.ts` owns the timer; the reducer decides close-vs-re-arm.
 *    AGENTS.md trap #10.
 * 4. **Our own jiggles never reach the reducer.** `SignalSource.jiggle()` emits
 *    no signal — both the real and the fake source guarantee it — and there is
 *    a test here that posts a jiggle every 30 s for ten minutes and asserts
 *    zero intervals were opened. AGENTS.md trap #4, the 24-hour-workday bug.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  initialLevels,
  initialState,
  levelsToSignals,
  reduce,
  NO_SIGNAL,
  type ClosedInterval,
  type Config,
  type Effect,
  type LevelState,
  type Signal,
  type TrackerState,
} from "../core";
import type { RawSignal, NativeStatus, SignalSource } from "../native";
import {
  countIntervals,
  insertClosed,
  openFromSnapshot,
  readJournal,
  recover,
  rowFromClosed,
  snapshotFromOpen,
  unionVsSum,
  writeJournal,
  hoursThisWeek as closedHoursThisWeekQuery,
  type Policy,
} from "../store";
import { DEFAULTS } from "../shared/constants";
import { localDateOf } from "../store/dates";
import type {
  DegradedReason,
  DoctorReport,
  EndReason,
  FlushResult,
  HoldKind,
  LiveStatus,
  MetricsBundle,
  MetricsPolicy,
  PermissionKey,
  PermissionSnapshot,
  SelfTestResult,
  SignalKind,
  TapHealth,
  ToggleChange,
  Toggles,
} from "../shared/ipc-types";
import { createDeadline, type Deadline } from "./deadline";
import { unconfiguredSync, type SyncSeam } from "./sync-seam";
import { buildMetrics } from "./metrics";
import { PermissionTracker } from "./onboarding";

/** The only push source in the app. The tray and the IPC fan-out both subscribe. */
export type RuntimeChange =
  | "interval-open"
  | "interval-close"
  | "signal"
  | "toggles"
  | "permissions"
  | "tap-health"
  | "sync"
  | "rows-pulled";

/** Everything main-process UI code is allowed to know about the app. */
export interface AppRuntime {
  readonly machineId: string;

  /** Recovers the crash journal, boots the reducer, installs the tap. */
  start(): Promise<void>;
  /** Journals the open interval, releases the tap, best-effort flush. Idempotent. */
  stop(reason?: EndReason): Promise<void>;

  /** Synchronous, cheap. Called on every tray refresh. */
  liveStatus(): LiveStatus;
  metrics(policy: MetricsPolicy): Promise<MetricsBundle>;

  toggles(): Toggles;
  /** Resolves only once the effect is DURABLE — see `setToggle` below. */
  setToggle(change: ToggleChange): Promise<Toggles>;

  permissions(): PermissionSnapshot;
  refreshPermissions(): Promise<PermissionSnapshot>;
  requestPermission(which: PermissionKey): Promise<PermissionSnapshot>;

  flushNow(): Promise<FlushResult>;
  doctor(): Promise<DoctorReport>;
  selfTest(): Promise<SelfTestResult>;

  /**
   * Change the idle timeout without a relaunch — PRD §7 makes it a setting, and
   * a setting that needs a restart to take effect is one the owner has to be
   * told about, which is a worse screen than this method is a method.
   *
   * It does NOT close anything and it cannot move a stored `ended_at_ms`: the
   * reducer still closes at `lastRealSignalMs`, whatever the timeout is. All
   * that changes is WHEN the countdown notices, which is why shortening it
   * re-arms immediately rather than waiting out the old deadline.
   */
  setIdleTimeoutMs(ms: number): void;

  onSuspend(atMs: number): Promise<void>;
  onResume(atMs: number, suspendedAtMs: number | null): Promise<void>;
  onScreenLock(atMs: number): void;
  onScreenUnlock(atMs: number): void;

  /** The watchdog's read-only report. Never posts anything. */
  onWatchdogTick(status: NativeStatus, atMs: number): void;
  /** The watchdog found the tap dead. Closes at the last signal we still trust. */
  onTapLost(atMs: number): void;
  /**
   * Re-run the camera/mic level → edge conversion. Called by the watchdog after
   * every probe, because the 60-second mic floor cannot be satisfied by an edge
   * that only fires once.
   */
  evaluateLevels(atMs: number): void;

  on(event: "change", cb: (kind: RuntimeChange) => void): () => void;
  /**
   * The sync service's way into the one fan-out there is.
   *
   * Rows arriving from the other Mac change what the dashboard shows, and
   * `RuntimeChange` is the only push source in the app — so a pull announces
   * itself here rather than growing a second subscription nobody remembers to
   * unsubscribe. Deliberately narrow: sync may announce sync, and nothing else.
   */
  notifySync(kind: "sync" | "rows-pulled"): void;
}

/**
 * The seam to `src/sync/`, re-exported so callers keep one import.
 *
 * The runtime deliberately does not import `src/main/sync.ts`: it is handed a
 * `SyncSeam` by `bootstrap.ts` and has no idea a Cloudflare Worker exists.
 * That is what lets `runtime.test.ts` drive the whole tracker against a
 * four-method fake and assert, directly, that closing an interval reaches the
 * flusher.
 */
export type { SyncHealth, SyncSeam, SyncSnapshot } from "./sync-seam";

export interface RuntimeOptions {
  readonly db: DatabaseSync;
  readonly source: SignalSource;
  readonly machineId: string;
  /**
   * READ PER CALL, never captured. A rename must show up in the tray title and
   * the status strip without a relaunch, and a string held here would freeze
   * both at whatever the name was when the app booted.
   */
  readonly machineLabel?: () => string;
  readonly appVersion: string;
  /** IANA zone. Read once at boot; rows carry the zone they happened in. */
  readonly tz: string;
  readonly policy: Policy;
  readonly dbPath?: string;
  /** Overrides for the reducer's knobs. Defaults come from `shared/constants`. */
  readonly config?: Partial<Omit<Config, "newId">>;
  readonly micMinCaptureMs?: number;
  readonly jigglerIntervalMs?: number;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly unschedule?: (t: NodeJS.Timeout) => void;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
  /**
   * Omitted or null behaves EXACTLY like an unconfigured install: honest, not
   * green, and never a throw. There is no third behaviour to test for.
   */
  readonly sync?: SyncSeam | null;
  /**
   * "Is a meeting app running." The mic alone is never a work signal — dictation
   * tools hold the microphone more or less continuously — so `src/core/levels`
   * conjoins it with this. Detecting it needs a process scan that no committed
   * module exposes yet, so it is injected and defaults to `false`: under-count
   * rather than invent a meeting.
   */
  readonly isMeetingAppRunning?: () => boolean;
  /**
   * Where the last self-test result is kept between launches.
   *
   * Injected rather than reached for, for the same reason the sync seam is:
   * this file must not know that `settings.json` exists. Omitted, the self-test
   * still runs and still answers — the doctor simply reports `selfTest: null`,
   * which is what it did before anything stored one.
   */
  readonly selfTestStore?: {
    read(): SelfTestResult | null;
    write(result: SelfTestResult): void | Promise<void>;
  };
}

const KEY_BITS = (1 << 10) | (1 << 11);
const FLAGS_CHANGED_BIT = 1 << 12;

export function maskHasBits(hex: string, bits: number): boolean {
  const mask = BigInt(hex);
  return (mask & BigInt(bits)) === BigInt(bits);
}

class Runtime implements AppRuntime {
  readonly machineId: string;

  private state: TrackerState = initialState;
  private levels: LevelState = initialLevels;
  /**
   * Not `readonly`: `setIdleTimeoutMs()` replaces it wholesale. The `Config`
   * OBJECT stays immutable — every field on it is `readonly` and `reduce()`
   * receives one value per call — so no in-flight reduction can see a knob
   * change underneath it.
   */
  private cfg: Config;
  private readonly deadline: Deadline;

  private cameraInUse = false;
  private micInUse = false;
  private lastSignalMsEver: number | null = null;
  private lastSignalKind: SignalKind | null = null;

  private keepAwake = false;
  private started = false;
  private stopped = false;

  private status: NativeStatus | null = null;
  private readonly perms = new PermissionTracker();
  private permSnapshot: PermissionSnapshot;
  private tapLostCount = 0;
  private tapRestarts = 0;
  private lastWatchdogTickMs: number | null = null;
  private dbWritable = true;
  private launchedAtMs: number;

  private jigglerTimer: NodeJS.Timeout | null = null;
  private lastSignalEmitMs = 0;
  private rowVersion = 0;
  private hoursCache: { key: string; week: number | null; today: number | null } | null = null;

  private readonly listeners = new Set<(kind: RuntimeChange) => void>();

  /**
   * Never null. An absent seam degrades to the unconfigured one, so there is a
   * single code path here and one fewer branch that could quietly stop calling
   * the flusher.
   */
  private readonly sync: SyncSeam;

  constructor(private readonly o: RuntimeOptions) {
    this.machineId = o.machineId;
    this.sync = o.sync ?? unconfiguredSync(o.db, () => this.now());
    this.cfg = {
      idleTimeoutMs: o.config?.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      minIntervalMs: o.config?.minIntervalMs ?? DEFAULTS.minIntervalMs,
      cameraOnlyMaxMs: o.config?.cameraOnlyMaxMs ?? DEFAULTS.cameraOnlyMaxMs,
      newId: o.newId ?? (() => randomUUID()),
    };
    this.launchedAtMs = this.now();
    this.deadline = createDeadline(
      (firedAtMs) => this.dispatch({ kind: "deadlineFired", atMs: firedAtMs }),
      () => this.now(),
      o.schedule,
      o.unschedule,
    );
    this.permSnapshot = this.perms.read(o.source, null);
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const at = this.now();

    // Recovery runs BEFORE the tap starts, so no live signal can race the
    // journal. A stale journal is closed at its last signal, never at wake time.
    recover(this.o.db, at, { tz: this.o.tz, appVersion: this.o.appVersion });
    this.rowVersion++;

    const snap = readJournal(this.o.db);
    // `boot` is an ordinary transition, not a special case: sleep, lid-close,
    // App Nap, force-quit, power loss and reboot all arrive here.
    this.dispatch({
      kind: "boot",
      atMs: at,
      journalled: snap === null ? null : openFromSnapshot(snap),
    });

    const status = await this.o.source.start((raw) => this.onRawSignal(raw));
    this.applyStatus(status, at);
  }

  async stop(reason: EndReason = "app_quit"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopJiggler();
    this.deadline.cancel();

    // The committed reducer deliberately leaves the row OPEN in the journal on
    // quit: the next boot applies the identical staleness rule, so quit needs no
    // special handling and cannot lose the tail. `docs/IMPL_UI.md` §1.3's table
    // says quit "closes the interval"; the committed `src/core/reduce.ts` does
    // not, and the committed code wins. A relaunch inside the idle timeout then
    // resumes the SAME interval id rather than splitting a six-hour day in two.
    this.dispatch({ kind: "appQuit", atMs: this.lastSignalMsEver ?? this.now() });
    void reason;

    this.o.source.setKeepAwake(false);
    this.keepAwake = false;
    this.o.source.stop();

    try {
      await this.sync.flush();
    } catch {
      // Best-effort. The mirror IS the outbox: nothing is lost by a failed
      // flush, and blocking quit on the network is how you get a force-quit.
    }
    // Disarm the backoff timer and WAIT for any drain still running. `cancel()`
    // is not enough: a drain past its first `await` still writes `synced_at_ms`,
    // and whoever closes the database next needs to be able to say "and nothing
    // of yours is still running".
    await this.sync.stop().catch(() => undefined);
  }

  // ── the signal path ──────────────────────────────────────────────────────

  /**
   * Everything the OS tells us arrives here, and nothing else does.
   *
   * Note what is absent: any branch for our own synthetic events. Filtering
   * them is `src/native/`'s job and it happens before the sink is called — a
   * jiggle produces no `RawSignal` at all, in both the real and the fake
   * source. If one ever did reach here it would be counted as human input and
   * the app would report 24-hour workdays, silently.
   */
  private onRawSignal(raw: RawSignal): void {
    switch (raw.kind) {
      case "key":
        this.noteSignal(raw.atMs, "input");
        this.dispatch({ kind: "realInput", atMs: raw.atMs, keys: raw.count ?? 1, mouse: 0 });
        return;
      case "mouse":
        this.noteSignal(raw.atMs, "input");
        this.dispatch({ kind: "realInput", atMs: raw.atMs, keys: 0, mouse: raw.count ?? 1 });
        return;
      case "camera_on":
      case "camera_off":
        this.cameraInUse = raw.kind === "camera_on";
        this.evaluateLevels(raw.atMs);
        return;
      case "mic_on":
      case "mic_off":
        this.micInUse = raw.kind === "mic_on";
        this.evaluateLevels(raw.atMs);
        return;
    }
  }

  evaluateLevels(atMs: number): void {
    const { next, signals } = levelsToSignals(
      this.levels,
      {
        cameraInUse: this.cameraInUse,
        micInUse: this.micInUse,
        meetingAppRunning: this.o.isMeetingAppRunning?.() ?? false,
        atMs,
      },
      this.o.micMinCaptureMs ?? DEFAULTS.micMinCaptureMs,
    );
    this.levels = next;
    for (const sig of signals) {
      this.noteSignal(atMs, sig.kind === "cameraOn" || sig.kind === "cameraOff" ? "camera" : "mic");
      this.dispatch(sig);
    }
  }

  private noteSignal(atMs: number, kind: SignalKind): void {
    if (this.lastSignalMsEver === null || atMs > this.lastSignalMsEver) {
      this.lastSignalMsEver = atMs;
    }
    this.lastSignalKind = kind;
  }

  /** The ONE mutation point. Everything else asks this. */
  private dispatch(sig: Signal): void {
    const before = this.state.open;
    const result = reduce(this.state, sig, this.cfg, this.now());
    this.state = result.state;
    const closed = this.applyEffects(result.effects);
    const after = this.state.open;

    if (closed.length > 0) {
      this.emit("interval-close");
      // THE WIRE. `docs/ARCHITECTURE.md` §5: flush on interval close. A row
      // reaches the outbox and the drain starts in the same tick — not on the
      // next tray refresh, not on the next launch. Fire-and-forget on purpose:
      // tracking must never wait on a network, and a failed flush loses nothing
      // because the mirror IS the outbox.
      this.flushAfterClose();
    }
    if (after !== null && (before === null || before.id !== after.id)) this.emit("interval-open");
    else if (closed.length === 0 && after !== null && before !== null && after !== before) {
      this.emitSignalDebounced();
    }
  }

  /** Effects are applied in order. `persist` is the only row-creating path. */
  private applyEffects(effects: readonly Effect[]): ClosedInterval[] {
    const closed: ClosedInterval[] = [];
    for (const fx of effects) {
      switch (fx.kind) {
        case "journal":
          this.write(() =>
            writeJournal(
              this.o.db,
              fx.open === null ? null : snapshotFromOpen(fx.open, this.machineId),
            ),
          );
          break;
        case "persist": {
          const row = rowFromClosed(fx.interval, {
            machineId: this.machineId,
            tz: this.o.tz,
            appVersion: this.o.appVersion,
            // The wall clock at close. This column is the skew diagnostic and is
            // the ONLY place `now()` legitimately appears on a row. It is not
            // the end of the interval and is never read as one.
            closedLocalMs: this.now(),
          });
          this.write(() => insertClosed(this.o.db, row));
          this.rowVersion++;
          this.hoursCache = null;
          closed.push(fx.interval);
          break;
        }
        case "armDeadline":
          // ABSOLUTE epoch ms, computed by the reducer from the last real
          // signal. Never a duration — a duration cannot survive sleep.
          this.deadline.arm(fx.atMs);
          break;
        case "cancelDeadline":
          this.deadline.cancel();
          break;
        case "tray":
          // The tray subscribes to `change`; nothing to do here. Listed so the
          // switch stays exhaustive and a new effect kind is a compile error.
          break;
        case "log":
          if (fx.event === "tap_lost") this.tapLostCount++;
          break;
      }
    }
    return closed;
  }

  private flushAfterClose(): void {
    void this.sync
      .flush()
      .then(() => this.emit("sync"))
      .catch((err: unknown) => {
        console.error("[runtime] flush after interval close failed", err);
      });
  }

  /** A database that has stopped accepting writes is a degraded state, not a crash. */
  private write(fn: () => void): void {
    try {
      fn();
      if (!this.dbWritable) {
        this.dbWritable = true;
        this.emit("tap-health");
      }
    } catch (err) {
      if (this.dbWritable) {
        this.dbWritable = false;
        this.emit("tap-health");
      }
      console.error("[runtime] database write failed", err);
    }
  }

  // ── toggles ──────────────────────────────────────────────────────────────

  toggles(): Toggles {
    const p = this.permSnapshot;
    const available = p.accessibility === "granted";
    return {
      jiggler: this.state.jiggler,
      keepAwake: this.keepAwake,
      paused: this.state.paused,
      jigglerAvailable: available,
      // A switch that appears on but does nothing is the failure mode to design
      // against. Without Accessibility it renders DISABLED and says why.
      jigglerUnavailableReason: available ? null : "needs Accessibility",
    };
  }

  /**
   * Resolves only after the effect is DURABLE:
   *
   *  - `jiggler`   → the interval boundary is committed to `work_interval` and
   *                  the successor interval is open (or none, if idle)
   *  - `paused`    → the open interval is closed
   *  - `keepAwake` → the power assertion is created or released
   *
   * Never fire-and-forget: the tray reads `liveStatus()` immediately afterwards.
   */
  async setToggle(change: ToggleChange): Promise<Toggles> {
    switch (change.key) {
      case "jiggler":
        this.setJiggler(change.value);
        break;
      case "paused":
        this.dispatch(
          change.value
            ? { kind: "pauseOn", atMs: this.lastSignalMsEver ?? this.now() }
            : { kind: "pauseOff", atMs: this.now() },
        );
        if (change.value) this.stopJiggler();
        else if (this.state.jiggler) this.startJiggler();
        break;
      case "keepAwake":
        // Never a work signal: a toggle is not evidence that anyone is here.
        this.o.source.setKeepAwake(change.value);
        this.keepAwake = change.value;
        break;
    }
    this.emit("toggles");
    return this.toggles();
  }

  /**
   * THE INTERVAL BOUNDARY. PRD §6 D1, AGENTS.md.
   *
   * Every stored interval must be homogeneous — `jiggler_s` is either `0` or
   * equal to `duration_s`, never in between — because partial coverage cannot
   * survive the cross-machine union merge, which works on timestamps and needs
   * a single truthful start and end.
   *
   * The reducer draws the boundary; this function does not reimplement it. What
   * it adds is the successor: `docs/IMPL_UI.md` §3.5 requires the new interval
   * to open at the SAME timestamp the old one closed at, so no wall-clock time
   * is lost at the seam, and the committed reducer leaves reopening to the next
   * real signal. So the successor is opened by dispatching the level or input
   * signal that was already holding the interval open, stamped at the
   * predecessor's own end — which is a real signal that really happened, not
   * `now()`.
   */
  private setJiggler(on: boolean): void {
    if (this.state.jiggler === on) return;
    const openBefore = this.state.open;
    const atMs = openBefore?.lastRealSignalMs ?? this.now();
    const hadInput = openBefore !== null && openBefore.lastInputMs !== NO_SIGNAL;

    this.dispatch({ kind: on ? "jigglerOn" : "jigglerOff", atMs });

    if (openBefore !== null && !this.state.paused) {
      // Reopen at the predecessor's end. Zero counts: no event is invented,
      // only the fact that presence continued across the seam.
      if (hadInput) this.dispatch({ kind: "realInput", atMs, keys: 0, mouse: 0 });
      else if (this.state.cameraOn) this.dispatch({ kind: "cameraOn", atMs });
      else if (this.state.micMeeting) this.dispatch({ kind: "micMeetingOn", atMs });
    }

    if (on && !this.state.paused) this.startJiggler();
    else this.stopJiggler();
  }

  private startJiggler(): void {
    if (this.jigglerTimer !== null) return;
    const every = this.o.jigglerIntervalMs ?? DEFAULTS.jigglerIntervalMs;
    const setRepeating = this.o.setRepeating ?? setInterval;
    this.jigglerTimer = setRepeating(() => {
      // Posts a stamped null event and emits NO signal. If this ever became a
      // signal the app would report 24-hour workdays. There is a test.
      this.o.source.jiggle();
    }, every);
  }

  private stopJiggler(): void {
    if (this.jigglerTimer === null) return;
    (this.o.clearRepeating ?? clearInterval)(this.jigglerTimer);
    this.jigglerTimer = null;
  }

  // ── permissions ──────────────────────────────────────────────────────────

  permissions(): PermissionSnapshot {
    return this.permSnapshot;
  }

  async refreshPermissions(): Promise<PermissionSnapshot> {
    return this.readPermissions();
  }

  async requestPermission(which: PermissionKey): Promise<PermissionSnapshot> {
    this.perms.request(this.o.source, which);
    return this.readPermissions();
  }

  private readPermissions(): PermissionSnapshot {
    const before = JSON.stringify({ ...this.permSnapshot, checkedAtMs: 0 });
    this.permSnapshot = this.perms.read(this.o.source, this.status);
    if (JSON.stringify({ ...this.permSnapshot, checkedAtMs: 0 }) !== before) {
      this.emit("permissions");
    }
    return this.permSnapshot;
  }

  // ── the watchdog's read-only report ──────────────────────────────────────

  onWatchdogTick(status: NativeStatus, atMs: number): void {
    this.lastWatchdogTickMs = atMs;
    // Backup layer 4, on the tick that already exists: a read of one integer
    // does not deserve a sixth timer. `docs/IMPL_STORE_SYNC.md` §8.
    this.sync.pollSilence(atMs);
    this.applyStatus(status, atMs);
  }

  private applyStatus(status: NativeStatus, atMs: number): void {
    const prevMask = this.status?.grantedMask;
    const prevEnabled = this.status?.tapEnabled;
    this.status = status;
    this.cameraInUse = status.cameraInUse;
    this.micInUse = status.micInUse;
    // The mask read is here, not only at boot, because a permission REVOKED in
    // System Settings while the app runs must produce the same loud degraded
    // state within one watchdog tick. M5 gate (c).
    this.readPermissions();
    this.evaluateLevels(atMs);
    if (prevMask !== status.grantedMask || prevEnabled !== status.tapEnabled) {
      this.emit("tap-health");
    }
  }

  onTapLost(atMs: number): void {
    this.tapRestarts++;
    // We may have silently missed input. Closing at the last signal we actually
    // trust is the honest thing; the alternative is inventing time.
    this.dispatch({ kind: "tapLost", atMs });
    this.emit("tap-health");
  }

  // ── power ────────────────────────────────────────────────────────────────

  async onSuspend(atMs: number): Promise<void> {
    void atMs;
    // Sleep does NOT close the interval. The countdown simply does not run; on
    // resume the wall-clock comparison decides. ARCHITECTURE §3.4.
    this.write(() =>
      writeJournal(
        this.o.db,
        this.state.open === null ? null : snapshotFromOpen(this.state.open, this.machineId),
      ),
    );
  }

  async onResume(atMs: number, suspendedAtMs: number | null): Promise<void> {
    void suspendedAtMs;
    // One signal, no special case: the reducer compares the wall clock against
    // the last real signal and either closes at that signal or re-arms.
    this.dispatch({ kind: "deadlineFired", atMs });
  }

  onScreenLock(atMs: number): void {
    // Lock does NOT close the interval — it matches Slack. PRD §3.2. Journal only.
    void this.onSuspend(atMs);
  }

  onScreenUnlock(atMs: number): void {
    this.dispatch({ kind: "deadlineFired", atMs });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  liveStatus(): LiveStatus {
    const nowMs = this.now();
    const open = this.state.open;
    const hours = this.closedHours(nowMs);
    const held: HoldKind | null = open === null ? null : this.heldBy();

    return {
      asOfMs: nowMs,
      state: this.state.paused ? "paused" : open ? "working" : "idle",
      openedAtMs: open?.startedAtMs ?? null,
      lastSignalMs: open ? open.lastRealSignalMs : this.lastSignalMsEver,
      lastSignalKind: this.lastSignalKind,
      // Absolute epoch ms, DISPLAY ONLY. The reducer never populates
      // `TrackerState.deadlineAtMs`, so the armed timer is the authority.
      deadlineMs: this.deadline.armedFor,
      heldOpenBy: held,
      heldUntilMs: held === null || open === null ? null : this.heldUntil(open.lastInputMs, open.startedAtMs),
      cameraOn: this.state.cameraOn,
      micCapturing: this.micInUse,
      meetingAppRunning: this.o.isMeetingAppRunning?.() ?? false,
      machineId: this.machineId,
      machineLabel: this.o.machineLabel?.() ?? "",
      closedHoursThisWeek: hours.week,
      closedHoursToday: hours.today,
      jigglerOnForOpenInterval: open !== null && this.state.jiggler,
      degraded: this.degraded(),
    };
  }

  private heldBy(): HoldKind | null {
    if (this.state.cameraOn) return "camera";
    if (this.state.micMeeting) return "mic";
    return null;
  }

  private heldUntil(lastInputMs: number, startedAtMs: number): number {
    const from = lastInputMs === NO_SIGNAL ? startedAtMs : lastInputMs;
    return from + this.cfg.cameraOnlyMaxMs;
  }

  /**
   * Closed, countable hours. `null` (not `0`) until the first row exists: `—`
   * means "no data" and `0` means "zero hours", and they are different pixels.
   */
  private closedHours(nowMs: number): { week: number | null; today: number | null } {
    const today = localDateOf(nowMs, this.o.tz);
    const key = `${today}|${this.rowVersion}`;
    if (this.hoursCache?.key === key) return this.hoursCache;
    let week: number | null = null;
    let day: number | null = null;
    try {
      if (countIntervals(this.o.db) > 0) {
        week = closedHoursThisWeekQuery(this.o.db, this.o.policy, this.o.tz, nowMs);
        day = unionVsSum(this.o.db, this.o.policy, today).unionH;
      }
    } catch (err) {
      console.error("[runtime] closed-hours query failed", err);
    }
    this.hoursCache = { key, week, today: day };
    return this.hoursCache;
  }

  /**
   * The degraded list — loud in four places at once (tray icon, tray title,
   * tray menu, dashboard banner). A silent zero is the failure mode this exists
   * to prevent: a user glancing at the menu bar must not be able to read a low
   * number as good news.
   *
   * Order is significant: the tooltip and the top menu item show `degraded[0]`,
   * so the reason that makes a NUMBER wrong comes first.
   *
   * `accessibility_missing` is deliberately NOT here merely because the grant is
   * absent. `docs/IMPL_UI.md` §4.5 lists it, but a fresh install without the
   * optional jiggler would then wear a permanent ⚠︎ in the menu bar while every
   * number in the app is correct — which teaches the user to ignore the warning
   * that matters. Missing Accessibility is already loud where it is true: the
   * jiggler switch is DISABLED and carries its reason. It joins `degraded` only
   * once the user has actually asked for the jiggler and not got it.
   */
  private degraded(): DegradedReason[] {
    const out: DegradedReason[] = [];
    const p = this.permSnapshot;
    if (!p.keyboardBitsGranted) out.push("keyboard_permission_missing");
    if (p.relaunchRequired) out.push("relaunch_required");
    if (this.status !== null && !this.status.tapEnabled) out.push("tap_lost");
    if (!this.dbWritable) out.push("db_unwritable");
    if (p.accessibility !== "granted" && (this.state.jiggler || p.promptConsumed.accessibility)) {
      out.push("accessibility_missing");
    }
    const sync = this.sync.health();
    if (sync.silentForMs !== null && sync.silentForMs > 72 * 3_600_000) {
      out.push("sync_silent_72h");
    }
    // Backup layer 3 — the only layer that catches SILENT loss. `null` is
    // "never checked" and says nothing; only a completed comparison that came
    // back different is worth a badge.
    if (sync.fingerprintMatched === false) out.push("fingerprint_mismatch");
    return out;
  }

  async metrics(policy: MetricsPolicy): Promise<MetricsBundle> {
    return buildMetrics(this.o.db, policy, this.o.policy, this.o.tz, this.now());
  }

  async flushNow(): Promise<FlushResult> {
    // Unconfigured answers here too, and answers honestly: `ok: false` with a
    // reason, never a green `ok: true` that means nothing.
    const res = await this.sync.flush();
    this.emit("sync");
    return res;
  }

  async selfTest(): Promise<SelfTestResult> {
    const report = await this.o.source.selfTest();
    const result: SelfTestResult = {
      ranAtMs: this.now(),
      passed: report.ok,
      appVersion: this.o.appVersion,
      checks: report.checks.map((c) => ({ id: c.name, passed: c.ok, detail: c.detail })),
    };
    // Recorded PASS OR FAIL. A store that only kept the good runs would let a
    // green date from last month outlive the failure that replaced it, which is
    // precisely the "plausible-looking wrong data with no error" this project
    // is built against.
    await this.o.selfTestStore?.write(result);
    return result;
  }

  setIdleTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.cfg.idleTimeoutMs) return;
    this.cfg = { ...this.cfg, idleTimeoutMs: ms };
    const open = this.state.open;
    if (open === null) return;
    // The armed timer was computed under the old value. Re-arm from the last
    // real signal so a SHORTENED timeout takes effect now instead of at the old
    // deadline; `arm()` is lazy, so a lengthened one keeps the earlier timer and
    // the reducer re-arms when it fires and finds the interval is not yet due.
    this.deadline.arm(open.lastRealSignalMs + ms);
  }

  tapHealth(): TapHealth {
    const s = this.status;
    const hex = s?.grantedMask ?? "0x0";
    return {
      created: s?.tapInstalled ?? false,
      enabled: s?.tapEnabled ?? false,
      grantedMaskHex: hex,
      keyboardBitsPresent: maskHasBits(hex, KEY_BITS),
      flagsChangedBitPresent: maskHasBits(hex, FLAGS_CHANGED_BIT),
      runLoopModes: ["default", "common"],
      eventsSinceLaunch: s?.counters.realEvents ?? 0,
      lastEventMs: this.lastSignalMsEver,
      disabledByTimeoutCount: s?.counters.disableNotices ?? 0,
      reEnabledCount: this.tapRestarts,
      tapLostRows: this.tapLostCount,
      lastWatchdogTickMs: this.lastWatchdogTickMs,
    };
  }

  async doctor(): Promise<DoctorReport> {
    const nowMs = this.now();
    const tap = this.tapHealth();
    // Real numbers from the real sync layer: pending rows, last flush, last
    // pull, watermark, fingerprint match, backup age, silence duration.
    const sync = this.sync.snapshot();
    const degraded = this.degraded();
    return {
      generatedAtMs: nowMs,
      allGreen: degraded.length === 0 && tap.enabled && tap.keyboardBitsPresent,
      app: {
        version: this.o.appVersion,
        electron: process.versions.electron ?? "",
        bundleId: "com.bpotter.workweekbuddy",
        execPath: process.execPath,
        isPackaged: false,
        launchedAtMs: this.launchedAtMs,
      },
      machine: {
        machineId: this.machineId,
        label: this.o.machineLabel?.() ?? "",
        osVersion: process.platform,
        tz: this.o.tz,
      },
      permissions: this.permSnapshot,
      tap,
      camera: {
        deviceCount: 0,
        inUse: this.cameraInUse,
        listenerRegistered: this.status !== null,
        lastReadMs: this.status?.probedAtMs ?? null,
      },
      mic: {
        inUse: this.micInUse,
        meetingAppRunning: this.o.isMeetingAppRunning?.() ?? false,
        meetingApp: null,
        needsPermission: null,
      },
      sync: sync.sync,
      fingerprint: sync.fingerprint,
      backup: sync.backup,
      // The LAST run, not a fresh one: `doctor()` is read on demand and the
      // self-test posts synthetic events, which would make simply looking at
      // the report change what the report is about.
      selfTest: this.o.selfTestStore?.read() ?? null,
      db: {
        path: this.o.dbPath ?? ":memory:",
        sizeBytes: 0,
        rows: countIntervals(this.o.db),
        openIntervalPresent: readJournal(this.o.db) !== null,
        integrityOk: this.dbWritable,
      },
      autostart: { installed: false, loaded: false, plistPath: "", execMatchesRunningApp: false },
      codesign: { designatedRequirementSha256: null, valid: null },
    };
  }

  // ── change fan-out ───────────────────────────────────────────────────────

  on(event: "change", cb: (kind: RuntimeChange) => void): () => void {
    void event;
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notifySync(kind: "sync" | "rows-pulled"): void {
    this.emit(kind);
  }

  private emit(kind: RuntimeChange): void {
    for (const cb of this.listeners) {
      try {
        cb(kind);
      } catch (err) {
        console.error("[runtime] change listener threw", err);
      }
    }
  }

  /** 300 events/second during a mouse drag. Never fan that out unthrottled. */
  private emitSignalDebounced(): void {
    const nowMs = this.now();
    if (nowMs - this.lastSignalEmitMs < 1000) return;
    this.lastSignalEmitMs = nowMs;
    this.emit("signal");
  }
}

export function createRuntime(options: RuntimeOptions): AppRuntime & { tapHealth(): TapHealth } {
  return new Runtime(options);
}
