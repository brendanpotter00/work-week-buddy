import { describe, it, expect } from "vitest";
import { initialLevels, levelsToSignals, type LevelInput, type LevelState } from "./levels";
import { NO_SIGNAL, type Signal } from "./types";
import { DEFAULTS } from "../shared/constants";

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIC_FLOOR = DEFAULTS.micMinCaptureMs;

function probe(over: Partial<LevelInput> & { atMs: number }): LevelInput {
  return { cameraInUse: false, micInUse: false, meetingAppRunning: false, ...over };
}

/** Feed a sequence of probes, collecting everything emitted. */
function poll(inputs: readonly LevelInput[], floor = MIC_FLOOR) {
  let state: LevelState = initialLevels;
  const signals: Signal[] = [];
  for (const input of inputs) {
    const r = levelsToSignals(state, input, floor);
    state = r.next;
    signals.push(...r.signals);
  }
  return { state, signals };
}

describe("camera levels become edges", () => {
  it("emits nothing while the level does not change", () => {
    const { signals } = poll([
      probe({ atMs: T0 }),
      probe({ atMs: T0 + SEC }),
      probe({ atMs: T0 + 2 * SEC }),
    ]);
    expect(signals).toEqual([]);
  });

  it("emits one cameraOn on the rising edge and one cameraOff on the falling edge", () => {
    const { signals } = poll([
      probe({ atMs: T0, cameraInUse: true }),
      probe({ atMs: T0 + SEC, cameraInUse: true }),
      probe({ atMs: T0 + 2 * SEC, cameraInUse: true }),
      probe({ atMs: T0 + 3 * SEC, cameraInUse: false }),
      probe({ atMs: T0 + 4 * SEC, cameraInUse: false }),
    ]);
    expect(signals).toEqual([
      { kind: "cameraOn", atMs: T0 },
      { kind: "cameraOff", atMs: T0 + 3 * SEC },
    ]);
  });

  it("tracks the camera level independently of the mic", () => {
    const { state } = poll([probe({ atMs: T0, cameraInUse: true })]);
    expect(state.camera).toBe(true);
    expect(state.micMeeting).toBe(false);
  });
});

describe("the mic conjunction — a mic is not a meeting", () => {
  it("never emits for mic capture without a meeting app running", () => {
    // Dictation tools hold the microphone more or less continuously.
    // PRD §3.5: mic alone is never a signal.
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 5 * 60 * SEC, micInUse: true }),
      probe({ atMs: T0 + 60 * 60 * SEC, micInUse: true }),
    ]);
    expect(signals).toEqual([]);
    expect(state.micMeeting).toBe(false);
  });

  it("never emits for a meeting app that is not capturing", () => {
    const { signals } = poll([
      probe({ atMs: T0, meetingAppRunning: true }),
      probe({ atMs: T0 + 10 * 60 * SEC, meetingAppRunning: true }),
    ]);
    expect(signals).toEqual([]);
  });

  it("requires sixty seconds of capture — a thirty-second blip emits nothing", () => {
    // A two-second Siri invocation must never open a work interval.
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 30 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 59 * SEC, micInUse: true, meetingAppRunning: true }),
    ]);
    expect(signals).toEqual([]);
  });

  it("emits micMeetingOn once both conditions have held for sixty seconds", () => {
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 30 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 90 * SEC, micInUse: true, meetingAppRunning: true }),
    ]);
    expect(signals).toEqual([{ kind: "micMeetingOn", atMs: T0 + 61 * SEC }]);
    expect(state.micMeeting).toBe(true);
    expect(state.micRisingAtMs).toBe(T0);
  });

  it("emits exactly at the sixty-second boundary", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + MIC_FLOOR, micInUse: true, meetingAppRunning: true }),
    ]);
    expect(signals).toEqual([{ kind: "micMeetingOn", atMs: T0 + MIC_FLOOR }]);
  });

  it("restarts the sixty-second clock when the mic drops", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 50 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 55 * SEC, micInUse: false, meetingAppRunning: true }),
      probe({ atMs: T0 + 60 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 100 * SEC, micInUse: true, meetingAppRunning: true }),
    ]);
    // Without the restart, the 100 s probe would qualify off the first rise.
    expect(signals).toEqual([]);
  });

  it("emits micMeetingOff when the meeting app quits mid-capture", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 120 * SEC, micInUse: true, meetingAppRunning: false }),
    ]);
    expect(signals).toEqual([
      { kind: "micMeetingOn", atMs: T0 + 61 * SEC },
      { kind: "micMeetingOff", atMs: T0 + 120 * SEC },
    ]);
  });

  it("emits micMeetingOff when capture stops", () => {
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 120 * SEC, micInUse: false, meetingAppRunning: true }),
    ]);
    expect(signals[1]).toEqual({ kind: "micMeetingOff", atMs: T0 + 120 * SEC });
    expect(state.micRisingAtMs).toBe(NO_SIGNAL);
  });

  it("counts the capture clock from the first rise, not from the app launching", () => {
    // The mic was already up when the meeting app appeared; the floor is a
    // floor on capture, and the capture has already been long enough.
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 10 * 60 * SEC, micInUse: true, meetingAppRunning: true }),
    ]);
    expect(signals).toEqual([{ kind: "micMeetingOn", atMs: T0 + 10 * 60 * SEC }]);
  });
});

describe("camera and mic together", () => {
  it("emits both edges from one probe", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true, meetingAppRunning: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true, meetingAppRunning: true, cameraInUse: true }),
    ]);
    expect(signals).toEqual([
      { kind: "cameraOn", atMs: T0 + 61 * SEC },
      { kind: "micMeetingOn", atMs: T0 + 61 * SEC },
    ]);
  });

  it("starts from a level state with nothing held", () => {
    expect(initialLevels).toEqual({ camera: false, micMeeting: false, micRisingAtMs: NO_SIGNAL });
  });
});
