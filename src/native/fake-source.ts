/**
 * The fake SignalSource. No koffi, no timers, no Date.now() unless you hand it
 * one.
 *
 * This is the most important file in src/native/: it is what lets the reducer,
 * the store, the flush, the tray and the dashboard be built and tested with no
 * Mac, no permission grant and no waiting. Everything the real machine would do
 * to you — a stripped mask, a dead tap, a revoked permission — is a one-line
 * method call.
 *
 * It keeps PARITY with the real source on the two things that matter:
 *   - a jiggle emits NO signal, ever (AGENTS.md trap #4: if our own synthetic
 *     input reached the reducer, hours would inflate with fake time, silently);
 *   - keep-awake emits no signal either — a toggle is not work.
 */
import { levelEdge, LEVEL_OFF, type LevelState } from "./levels";
import type {
  NativeStatus,
  Permissions,
  SelfTestReport,
  SignalSink,
  SignalSource,
  TapRevival,
} from "./types";

export class FakeSignalSource implements SignalSource {
  private sink: SignalSink = () => {};
  private started = false;
  private camera: LevelState = LEVEL_OFF;
  private mic: LevelState = LEVEL_OFF;

  // ── knobs a test turns ──────────────────────────────────────────────────
  cameraOn = false;
  micOn = false;
  tapEnabled = true;
  keyboardBits = true;
  perms: Permissions = {
    listenEvent: true,
    postEvent: true,
    axTrusted: true,
    listenEventAccess: "granted",
    postEventAccess: "granted",
  };
  /** Every jiggle that was posted, as epoch ms. Assert on length, not on side effects. */
  readonly jiggles: number[] = [];
  keepAwake = false;
  restarts = 0;
  /** True → `CGEventTapEnable(true)` is refused and only a full rebuild works. */
  reviveRefusesEnable = false;
  /** True → nothing brings the tap back. This, and only this, is a tap loss. */
  tapUnrecoverable = false;
  reviveCalls = 0;
  disableNotices = 0;
  disableNoticesByUserInput = 0;
  lastDisableType = 0;
  lastDisableAtMs = 0;
  reEnables = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async start(sink: SignalSink): Promise<NativeStatus> {
    this.sink = sink;
    this.started = true;
    return this.probe();
  }

  stop(): void {
    this.started = false;
    this.keepAwake = false;
  }

  probe(): NativeStatus {
    const at = this.now();
    const c = levelEdge(this.camera, this.cameraOn, at, "camera_on", "camera_off");
    this.camera = c.next;
    if (c.signal) this.sink(c.signal);
    const m = levelEdge(this.mic, this.micOn, at, "mic_on", "mic_off");
    this.mic = m.next;
    if (m.signal) this.sink(m.signal);
    return {
      tapInstalled: this.started,
      tapEnabled: this.started && this.tapEnabled,
      keyboardBitsGranted: this.keyboardBits,
      grantedMask: this.keyboardBits ? "0xfc01cfe" : "0xfc000fe",
      cameraInUse: this.cameraOn,
      micInUse: this.micOn,
      probedAtMs: at,
      counters: {
        realEvents: this.realEvents,
        ourEvents: this.jiggles.length,
        foreignNullEvents: 0,
        disableNotices: this.disableNotices,
        disableNoticesByUserInput: this.disableNoticesByUserInput,
        lastDisableType: this.lastDisableType,
        lastDisableAtMs: this.lastDisableAtMs,
        reEnables: this.reEnables,
        reEnableFailures: 0,
        callbackErrors: 0,
        lastCallbackError: "",
        drainsOverdue: 0,
        worstDrainLagMs: 0,
        numberContractViolations: 0,
        lastRealSignalMs: this.lastRealSignalMs,
      },
    };
  }

  tapAlive(): boolean {
    return this.started && this.tapEnabled;
  }

  /**
   * Parity with the real thing: the cheap re-enable first, a rebuild if that is
   * refused, and `dead` when the machine will not give the tap back at all.
   * `reviveRefusesEnable` and `tapUnrecoverable` are what a test turns to walk
   * the app down each of those branches without a Mac.
   */
  reviveTap(): TapRevival {
    this.reviveCalls++;
    if (!this.started) return { outcome: "dead", detail: "source not started" };
    if (this.tapEnabled) return { outcome: "healthy", detail: "" };
    if (this.tapUnrecoverable) return { outcome: "dead", detail: "fake: unrecoverable" };
    this.reEnables++;
    if (!this.reviveRefusesEnable) {
      this.tapEnabled = true;
      return { outcome: "reenabled", detail: "fake: re-enable took" };
    }
    this.restarts++;
    this.tapEnabled = true;
    return { outcome: "rebuilt", detail: "fake: rebuilt" };
  }

  restart(): NativeStatus {
    this.restarts++;
    this.tapEnabled = true;
    return this.probe();
  }

  jiggle(): boolean {
    // Silent-failure parity: without Accessibility the real CGEventPost posts
    // nothing and reports nothing, so the fake returns false and posts nothing.
    if (!this.perms.postEvent && !this.perms.axTrusted) return false;
    this.jiggles.push(this.now());
    return true; // and NO signal is emitted
  }

  setKeepAwake(on: boolean): void {
    this.keepAwake = on;
  }

  permissions(): Permissions {
    return this.perms;
  }

  requestPermissions(): Permissions {
    return this.perms;
  }

  async selfTest(): Promise<SelfTestReport> {
    return { ok: true, checks: [{ name: "fake", ok: true, detail: "no native calls" }] };
  }

  // ── the test driver ─────────────────────────────────────────────────────
  private realEvents = 0;
  private lastRealSignalMs = 0;

  key(atMs: number, count = 1): void {
    this.emit({ kind: "key", atMs, count });
  }

  mouse(atMs: number, count = 1): void {
    this.emit({ kind: "mouse", atMs, count });
  }

  /** Play a whole day in one call: [[epochMs, 'key'], …]. */
  script(events: ReadonlyArray<[number, "key" | "mouse"]>): void {
    for (const [atMs, kind] of events) this.emit({ kind, atMs, count: 1 });
  }

  private emit(s: { kind: "key" | "mouse"; atMs: number; count: number }): void {
    this.realEvents += s.count;
    if (s.atMs > this.lastRealSignalMs) this.lastRealSignalMs = s.atMs;
    this.sink(s);
  }

  /**
   * macOS killed the tap. Nothing is emitted — that is the whole point.
   *
   * `type` mirrors what the real disable notice carries, so a test can tell the
   * two documented causes apart. Both must recover the same way, and the app
   * must not need the owner to touch anything for either.
   */
  killTap(type: "timeout" | "userInput" = "timeout"): void {
    this.tapEnabled = false;
    this.disableNotices++;
    this.lastDisableType = type === "timeout" ? 0xfffffffe : 0xffffffff;
    this.lastDisableAtMs = this.now();
    if (type === "userInput") this.disableNoticesByUserInput++;
  }

  /** Input Monitoring revoked: the tap lives, the keyboard bits are gone. */
  stripKeyboardBits(): void {
    this.keyboardBits = false;
  }
}
