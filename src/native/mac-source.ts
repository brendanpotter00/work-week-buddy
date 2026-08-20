/**
 * The real SignalSource. A thin adapter over native.ts — it holds the two level
 * states and owns no timers, because main owns the single 5-minute watchdog and
 * calls probe() on it.
 *
 * Importing this module imports native.ts, which throws at module scope on a
 * non-Mac. That is why src/native/index.ts reaches it through a dynamic import.
 */
import * as native from "./native";
import { levelEdge, LEVEL_OFF, type LevelState } from "./levels";
import type {
  NativeStatus,
  Permissions,
  SelfTestReport,
  SignalSink,
  SignalSource,
} from "./types";

export class MacSignalSource implements SignalSource {
  private sink: SignalSink = () => {};
  private started = false;
  private camera: LevelState = LEVEL_OFF;
  private mic: LevelState = LEVEL_OFF;

  async start(sink: SignalSink): Promise<NativeStatus> {
    this.sink = sink;
    native.installTap(sink);
    this.started = true;
    return this.probe();
  }

  stop(): void {
    if (!this.started) return;
    native.removeTap();
    native.releaseJiggleSource();
    native.setKeepAwake(false);
    this.started = false;
  }

  probe(): NativeStatus {
    const at = Date.now();
    native.reanchorClock();
    const cameraOn = native.anyCameraInUse();
    const micOn = native.anyMicInUse();

    const cam = levelEdge(this.camera, cameraOn, at, "camera_on", "camera_off");
    this.camera = cam.next;
    if (cam.signal) this.sink(cam.signal);

    const m = levelEdge(this.mic, micOn, at, "mic_on", "mic_off");
    this.mic = m.next;
    if (m.signal) this.sink(m.signal);

    const mask = native.grantedMask();
    return {
      tapInstalled: this.started,
      tapEnabled: native.isTapEnabled(),
      keyboardBitsGranted: native.keyboardBitsGranted(),
      // Hex string, never a BigInt: BigInt is not JSON-serialisable, so a mask
      // that crossed IPC as one would throw in a log line, not here.
      grantedMask: mask === null ? "-" : `0x${mask.toString(16)}`,
      cameraInUse: cameraOn,
      micInUse: micOn,
      probedAtMs: at,
      counters: { ...native.counters },
    };
  }

  restart(): NativeStatus {
    native.restartTap(this.sink);
    return this.probe();
  }

  jiggle(): boolean {
    return native.postJiggle();
  }

  setKeepAwake(on: boolean): void {
    native.setKeepAwake(on);
  }

  permissions(): Permissions {
    return native.permissions();
  }

  requestPermissions(o: { prompt: boolean }): Permissions {
    return native.requestPermissions(o);
  }

  selfTest(): Promise<SelfTestReport> {
    return native.selfTest();
  }
}
