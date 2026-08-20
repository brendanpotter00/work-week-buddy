/**
 * The macOS surface, as one interface — and nothing else.
 *
 * Zero imports on purpose: this file is safe to import from anywhere, including
 * a test running on Linux with no koffi, no Electron and no TCC grant. Every
 * other module in the app talks to macOS through `SignalSource`, which is what
 * lets the reducer, the store, the flush and the tray be built and tested with
 * no Mac in the loop. See docs/IMPL_NATIVE.md section 13.
 */

export type SignalKind =
  | "key"
  | "mouse"
  | "camera_on"
  | "camera_off"
  | "mic_on"
  | "mic_off";

export interface RawSignal {
  readonly kind: SignalKind;
  /**
   * Epoch ms. For 'key' and 'mouse' this is the HARDWARE timestamp of the last
   * event in the burst, converted — never `Date.now()`, and never the instant
   * the drain happened to run. For the level kinds see docs/IMPL_NATIVE.md §9.
   */
  readonly atMs: number;
  /** Coalesced event count. Present for 'key' and 'mouse' only. */
  readonly count?: number;
}

export type SignalSink = (signal: RawSignal) => void;

export interface NativeCountersSnapshot {
  readonly realEvents: number;
  readonly ourEvents: number;
  /**
   * kCGEventNull events that were NOT ours — another app's jiggler, or the one
   * unstamped null the WindowServer emits alongside our first post. They are
   * dropped rather than counted as input, because nothing a human does produces
   * a null event. A number that climbs steadily means something else on the
   * machine is faking activity.
   */
  readonly foreignNullEvents: number;
  readonly disableNotices: number;
  readonly lastDisableType: number;
  readonly callbackErrors: number;
  readonly lastCallbackError: string;
  readonly inlineDrains: number;
  /**
   * AGENTS.md trap #4. A koffi field read that came back as a BigInt rather
   * than a Number. Non-zero means the ours-vs-theirs comparison is at risk of
   * being silently false, which is how a jiggler produces 24-hour workdays.
   */
  readonly numberContractViolations: number;
  readonly lastRealSignalMs: number;
}

export interface NativeStatus {
  readonly tapInstalled: boolean;
  readonly tapEnabled: boolean;
  readonly keyboardBitsGranted: boolean;
  /** Hex string, never a BigInt: BigInt is not JSON-serialisable and dies in IPC logs. */
  readonly grantedMask: string;
  readonly cameraInUse: boolean;
  readonly micInUse: boolean;
  readonly probedAtMs: number;
  readonly counters: NativeCountersSnapshot;
}

export interface Permissions {
  /** kTCCServiceListenEvent — Input Monitoring. The keyboard bits in the tap. */
  readonly listenEvent: boolean;
  /** kTCCServicePostEvent — Accessibility. The jiggler. */
  readonly postEvent: boolean;
  /** AXIsProcessTrusted — the other half of the Accessibility story. */
  readonly axTrusted: boolean;
}

export interface SelfTestCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SelfTestReport {
  readonly ok: boolean;
  readonly checks: readonly SelfTestCheck[];
}

/**
 * The whole macOS surface, in one interface.
 *
 * Note what is NOT here: no timers. `src/main/` owns the single 5-minute
 * watchdog and the jiggler's 30-second interval, and calls `probe()`/`jiggle()`.
 * A source that owned its own timers could not be driven deterministically from
 * a test.
 */
export interface SignalSource {
  /** Install the tap and take the first level readings. Throws loudly on a fatal. */
  start(sink: SignalSink): Promise<NativeStatus>;
  /** Idempotent teardown. Safe to call twice, safe to call before start(). */
  stop(): void;
  /**
   * The read-only watchdog probe. Reads three integers, re-anchors the clock,
   * emits camera/mic edges through the sink, and POSTS NOTHING. There is no
   * side-effect-free active liveness probe — even a null canary resets the idle
   * clock — so this must stay passive.
   */
  probe(): NativeStatus;
  /** Full teardown + rebuild after a tap death. Caller logs the tap_lost row. */
  restart(): NativeStatus;
  /** Post one stamped null event. False (and nothing posted) without Accessibility. */
  jiggle(): boolean;
  /** One power assertion, or release it. Idempotent. Never a work signal. */
  setKeepAwake(on: boolean): void;
  permissions(): Permissions;
  requestPermissions(opts: { prompt: boolean }): Permissions;
  selfTest(): Promise<SelfTestReport>;
}
