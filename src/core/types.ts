/**
 * The interval model.
 *
 * This module is PURE. It never imports electron, never touches I/O, and never
 * reads the clock — time arrives as a parameter. That is what makes the
 * sleep/wake and crash cases testable, and those are where the bugs are.
 */

/** Epoch milliseconds, UTC. */
export type Ms = number;

/** "No signal yet". Never use 0 — 0 is a valid epoch. */
export const NO_SIGNAL = -1;

export type StartSource = "input" | "camera" | "mic" | "recovery";

export type EndReason =
  | "idle_timeout"
  | "camera_cap"
  | "jiggler_toggle"
  | "pause"
  | "app_quit"
  | "tap_lost"
  | "crash_recovered";

export interface OpenInterval {
  readonly id: string;
  readonly startedAtMs: Ms;
  readonly startSource: StartSource;
  /** THE load-bearing field. The interval will end here, and nowhere else. */
  readonly lastRealSignalMs: Ms;
  /**
   * Last keyboard or mouse signal specifically. Camera and mic do not move it,
   * which is what makes the camera-only cap computable.
   */
  readonly lastInputMs: Ms;
  readonly keyEvents: number;
  readonly mouseEvents: number;
  /** Accumulated closed spans. The `…SinceMs` fields hold the currently-open one. */
  readonly cameraMs: number;
  readonly micMs: number;
  readonly jigglerMs: number;
  readonly cameraSinceMs: Ms;
  readonly micSinceMs: Ms;
  readonly jigglerSinceMs: Ms;
}

export interface ClosedInterval
  extends Omit<OpenInterval, "cameraSinceMs" | "micSinceMs" | "jigglerSinceMs"> {
  readonly endedAtMs: Ms;
  readonly durationS: number;
  readonly endReason: EndReason;
}

export type Signal =
  /**
   * App start. Carries whatever was journalled, so recovery is an ordinary
   * transition rather than a special case in the boot path. Sleep, lid-close,
   * App Nap, force-quit, power loss and reboot all arrive here.
   */
  | { kind: "boot"; atMs: Ms; journalled: OpenInterval | null }
  /**
   * Real human input. Our own jiggles are filtered in src/native/ and never
   * reach this reducer.
   */
  | { kind: "realInput"; atMs: Ms; keys: number; mouse: number }
  | { kind: "cameraOn"; atMs: Ms }
  | { kind: "cameraOff"; atMs: Ms }
  /** Already conjoined with "a meeting app is running". */
  | { kind: "micMeetingOn"; atMs: Ms }
  | { kind: "micMeetingOff"; atMs: Ms }
  | { kind: "jigglerOn"; atMs: Ms }
  | { kind: "jigglerOff"; atMs: Ms }
  | { kind: "pauseOn"; atMs: Ms }
  | { kind: "pauseOff"; atMs: Ms }
  /**
   * The countdown reached zero. `atMs` is when it actually fired, which after
   * sleep can be far later than the deadline it was armed for.
   */
  | { kind: "deadlineFired"; atMs: Ms }
  /** The watchdog found the tap dead, so input may have been missed. */
  | { kind: "tapLost"; atMs: Ms }
  | { kind: "appQuit"; atMs: Ms };

export interface TrackerState {
  readonly open: OpenInterval | null;
  readonly cameraOn: boolean;
  readonly micMeeting: boolean;
  readonly jiggler: boolean;
  readonly paused: boolean;
  /** Absolute epoch ms. Never a duration — a duration cannot survive sleep. */
  readonly deadlineAtMs: Ms | null;
}

export const initialState: TrackerState = {
  open: null,
  cameraOn: false,
  micMeeting: false,
  jiggler: false,
  paused: false,
  deadlineAtMs: null,
};

export type Effect =
  /** Journal the open interval so a crash cannot lose the truncation point. */
  | { kind: "journal"; open: OpenInterval | null }
  /** Write a finished interval. The only place rows are created. */
  | { kind: "persist"; interval: ClosedInterval }
  | { kind: "armDeadline"; atMs: Ms }
  | { kind: "cancelDeadline" }
  | { kind: "tray"; workingSinceMs: Ms | null }
  | { kind: "log"; event: string; detail?: string };

export interface Config {
  readonly idleTimeoutMs: number;
  readonly minIntervalMs: number;
  readonly cameraOnlyMaxMs: number;
  /** Injected so the reducer is deterministic and property-testable. */
  readonly newId: () => string;
}

export interface ReduceResult {
  readonly state: TrackerState;
  readonly effects: readonly Effect[];
}
