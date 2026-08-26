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
  /**
   * Of those, the ones that were NOT a keystroke — moves, drags, clicks,
   * scrolls, tablet input.
   *
   * Split out for the cursor-stillness check in the self-test, which needs to
   * know whether anything other than us could have moved the pointer inside its
   * measurement window. A keystroke cannot move a cursor, and the human running
   * `install.sh` has their hands on the keyboard by definition, so counting
   * typing there would void every window for no reason. See
   * `src/native/cursor-stillness.ts`.
   */
  readonly realPointerEvents: number;
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
  /** Of those, the ones that were kCGEventTapDisabledByUserInput. */
  readonly disableNoticesByUserInput: number;
  readonly lastDisableType: number;
  readonly lastDisableAtMs: number;
  /** Re-enables issued from inside the disable-notice callback. */
  readonly reEnables: number;
  /**
   * Re-enables that did not take. Non-zero means the callback cannot heal the
   * tap by itself and the watchdog's liveness beat is what is keeping the app
   * measuring. Before this counter existed the re-enable was issued and never
   * verified, so nothing could tell those two states apart.
   */
  readonly reEnableFailures: number;
  readonly callbackErrors: number;
  readonly lastCallbackError: string;
  /**
   * Drains that ran more than 50 ms after they were scheduled — the main
   * thread was starved. Recorded, never acted on from inside the tap callback:
   * doing the drain there is a synchronous SQLite write on the one code path
   * where a slow return costs you the tap.
   */
  readonly drainsOverdue: number;
  readonly worstDrainLagMs: number;
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
  /**
   * How many video devices CoreMediaIO can see at this probe.
   *
   * Carried alongside `cameraInUse` because zero devices and zero cameras in
   * use are the same boolean and completely different diagnoses — see
   * `CameraStatus` in `native.ts`.
   */
  readonly cameraDeviceCount: number;
  readonly micInUse: boolean;
  readonly probedAtMs: number;
  readonly counters: NativeCountersSnapshot;
}

/**
 * What it took to get the tap back.
 *
 *  - `healthy`    it was never off; the check cost one boolean read
 *  - `reenabled`  the port was still ours and CGEventTapEnable(true) took
 *  - `rebuilt`    the re-enable was refused, so the tap was torn down and
 *                 reinstalled
 *  - `dead`       neither worked — no Input Monitoring, or not a GUI session
 *
 * `reenabled` and `rebuilt` are recoveries: input was invisible for at most one
 * liveness beat, and the open interval is NOT closed for that. Only `dead` is a
 * tap loss, and only a tap loss closes an interval — at the last signal we
 * still trust, never at now().
 */
export type TapRevivalOutcome = "healthy" | "reenabled" | "rebuilt" | "dead";

export interface TapRevival {
  readonly outcome: TapRevivalOutcome;
  readonly detail: string;
}

/**
 * The three states a TCC row can actually be in — `IOHIDCheckAccess`, not a
 * preflight bool.
 *
 * `"denied"` is the one that matters and the one no boolean API can express:
 * it is `auth_value = 0` in TCC.db, and it is a DEAD END. macOS shows a
 * permission prompt exactly once per (service, code identity); once a row says
 * denied, every later `CGRequest…Access` call returns false without drawing
 * anything. The only ways out are the checkbox in System Settings or
 * `tccutil reset`, so a UI that keeps offering to "grant" is lying.
 */
export type AccessState = "granted" | "denied" | "unknown";

export interface Permissions {
  /** kTCCServiceListenEvent — Input Monitoring. The keyboard bits in the tap. */
  readonly listenEvent: boolean;
  /** kTCCServicePostEvent — Accessibility. The jiggler. */
  readonly postEvent: boolean;
  /** AXIsProcessTrusted — the other half of the Accessibility story. */
  readonly axTrusted: boolean;
  /** `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` — distinguishes denied from never-asked. */
  readonly listenEventAccess: AccessState;
  /** `IOHIDCheckAccess(kIOHIDRequestTypePostEvent)` — distinguishes denied from never-asked. */
  readonly postEventAccess: AccessState;
}

export interface SelfTestCheck {
  readonly name: string;
  /**
   * The gate. `ok: false` stops `scripts/install.sh` before launch-at-login is
   * wired up, and switches the jiggler back off if it happens at toggle time.
   *
   * It answers ONE question — "does this fail the install?" — which is why an
   * inconclusive check carries `ok: true`. See below.
   */
  readonly ok: boolean;
  readonly detail: string;
  /**
   * The check ran and could not reach a verdict. Neither a pass nor a failure.
   *
   * Some things cannot be measured while a person is using the Mac, and
   * `--selftest` runs at exactly the moment one is: `install.sh` invokes it the
   * instant the install finishes, and `runtime.ts` invokes it the instant the
   * jiggler is switched on. A check that cannot separate "the app is broken"
   * from "the owner moved the mouse" must say so rather than pick one.
   *
   * FAILING would train the owner to bypass the gate — measured, twice, on his
   * own Mac, and the bypass is what got his tracker running again. PASSING
   * silently would let a real regression through under cover of a busy machine.
   * So it does neither: `ok` stays true so the install proceeds, `inconclusive`
   * is true so `--selftest` prints `?` instead of `ok` and `install.sh` warns.
   *
   * Only ever set on a check that has genuinely no verdict. It is not a
   * softer way to fail.
   */
  readonly inconclusive?: boolean;
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
  /**
   * One CoreGraphics boolean: is the tap still armed?
   *
   * Split out from `probe()` because `probe()` also walks the CoreMediaIO and
   * CoreAudio device lists, which are synchronous HAL round trips and far too
   * expensive to run at the cadence a dead tap has to be caught at. This one
   * is cheap enough to ask every couple of seconds, and posts nothing.
   */
  tapAlive(): boolean;
  /**
   * Get the tap back without posting anything. Called by the watchdog's
   * liveness beat whenever `tapAlive()` says no.
   */
  reviveTap(): TapRevival;
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
