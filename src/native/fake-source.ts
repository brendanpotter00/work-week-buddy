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
  perms: Permissions = { listenEvent: true, postEvent: true, axTrusted: true };
  /** Every jiggle that was posted, as epoch ms. Assert on length, not on side effects. */
  readonly jiggles: number[] = [];
  keepAwake = false;
  restarts = 0;

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
        disableNotices: 0,
        lastDisableType: 0,
        callbackErrors: 0,
        lastCallbackError: "",
        inlineDrains: 0,
        numberContractViolations: 0,
        lastRealSignalMs: this.lastRealSignalMs,
      },
    };
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

  /** macOS killed the tap. Nothing is emitted — that is the whole point. */
  killTap(): void {
    this.tapEnabled = false;
  }

  /** Input Monitoring revoked: the tap lives, the keyboard bits are gone. */
  stripKeyboardBits(): void {
    this.keyboardBits = false;
  }
}
