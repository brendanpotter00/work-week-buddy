/**
 * Levels into edges.
 *
 * This file used to be built around a CONJUNCTION: the microphone counted only
 * while a recognised meeting application was also running. That is gone. The
 * mic is a work signal on its own, and the tests below are the record of that
 * decision rather than a rename of the old ones — `LevelInput` no longer has an
 * app-identity field for a test to set, so "mic without a meeting app" is not a
 * case that can be expressed here any more.
 *
 * What survives, and must keep surviving: the 60-second floor. It is the whole
 * reason a two-second Siri invocation does not open a work interval.
 */
import { describe, it, expect } from "vitest";
import { initialLevels, levelsToSignals, type LevelInput, type LevelState } from "./levels";
import { NO_SIGNAL, type Signal } from "./types";
import { DEFAULTS } from "../shared/constants";

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const MIC_FLOOR = DEFAULTS.micMinCaptureMs;

function probe(over: Partial<LevelInput> & { atMs: number }): LevelInput {
  return { cameraInUse: false, micInUse: false, ...over };
}

/** Feed a sequence of probes, collecting everything emitted. */
function poll(inputs: readonly LevelInput[], floor: number = MIC_FLOOR) {
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

  it("the camera has no floor — it is an edge the instant it is seen", () => {
    // Unchanged by the mic simplification, and asserted here so a future edit
    // to the floor cannot quietly grow a camera delay as a side effect.
    const { signals } = poll([probe({ atMs: T0, cameraInUse: true })]);
    expect(signals).toEqual([{ kind: "cameraOn", atMs: T0 }]);
  });

  it("tracks the camera level independently of the mic", () => {
    const { state } = poll([probe({ atMs: T0, cameraInUse: true })]);
    expect(state.camera).toBe(true);
    expect(state.micActive).toBe(false);
  });
});

describe("the microphone is a work signal on its own", () => {
  it("opens on mic capture alone — there is no meeting app and no such concept", () => {
    // THE REVERSAL. Nothing else is true in this scenario: no camera, no
    // keyboard, no mouse, and nothing anywhere that knows what an application
    // is. A held microphone is enough.
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 2 * MIN, micInUse: true }),
    ]);
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + 2 * MIN }]);
    expect(state.micActive).toBe(true);
  });

  it("counts a dictation tool holding the mic all day as work", () => {
    // THE EXPLICIT REVERSAL, named so the intent stays legible. Under the old
    // conjunction this emitted NOTHING for eight straight hours: Wispr Flow is
    // not a meeting app, so a day spent dictating was recorded as idle. The
    // owner's judgement is that nobody holds a microphone while not working.
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 60 * MIN, micInUse: true }),
      probe({ atMs: T0 + 8 * 60 * MIN, micInUse: true }),
    ]);
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + 60 * MIN }]);
    expect(state.micActive).toBe(true);
  });

  it("emits micOn exactly once, not on every probe that follows", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true }),
      probe({ atMs: T0 + 90 * SEC, micInUse: true }),
      probe({ atMs: T0 + 120 * SEC, micInUse: true }),
    ]);
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + 61 * SEC }]);
  });

  it("emits micOff when capture stops", () => {
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true }),
      probe({ atMs: T0 + 120 * SEC, micInUse: false }),
    ]);
    expect(signals).toEqual([
      { kind: "micOn", atMs: T0 + 61 * SEC },
      { kind: "micOff", atMs: T0 + 120 * SEC },
    ]);
    expect(state.micActive).toBe(false);
    expect(state.micRisingAtMs).toBe(NO_SIGNAL);
  });
});

describe("the sixty-second floor, which survives the simplification", () => {
  it("never opens an interval for a capture shorter than the floor", () => {
    // A two-second Siri invocation, a dictation blip, a Zoom join sound. The
    // floor is the ONLY thing standing between those and a work interval now
    // that app identity is gone, so it is load-bearing rather than incidental.
    const { signals, state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 2 * SEC, micInUse: true }),
      probe({ atMs: T0 + 30 * SEC, micInUse: true }),
      probe({ atMs: T0 + 59 * SEC, micInUse: true }),
      probe({ atMs: T0 + 59 * SEC, micInUse: false }),
    ]);
    expect(signals).toEqual([]);
    expect(state.micActive).toBe(false);
  });

  it("emits exactly at the sixty-second boundary, not one probe later", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + MIC_FLOOR, micInUse: true }),
    ]);
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + MIC_FLOOR }]);
  });

  it("takes the floor as a parameter rather than reading a constant", () => {
    // `micMinCaptureMs` stays configurable at the seam even though no user can
    // configure it, because the reducer's knobs are what make a fifteen-minute
    // case arithmetic instead of a fifteen-minute wait.
    const { signals } = poll(
      [probe({ atMs: T0, micInUse: true }), probe({ atMs: T0 + 5 * SEC, micInUse: true })],
      5 * SEC,
    );
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + 5 * SEC }]);
  });

  it("restarts the clock when the mic drops, so two short captures never sum", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 50 * SEC, micInUse: true }),
      probe({ atMs: T0 + 55 * SEC, micInUse: false }),
      probe({ atMs: T0 + 60 * SEC, micInUse: true }),
      probe({ atMs: T0 + 100 * SEC, micInUse: true }),
    ]);
    // Without the restart, the 100 s probe would qualify off the first rise.
    expect(signals).toEqual([]);
  });

  it("measures the floor from the first rise, not from the first probe that sees it", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      // The next probe is ten minutes later; the capture has already been long
      // enough and the edge is stamped when it was OBSERVED, never back-dated.
      probe({ atMs: T0 + 10 * MIN, micInUse: true }),
    ]);
    expect(signals).toEqual([{ kind: "micOn", atMs: T0 + 10 * MIN }]);
  });

  it("keeps micRisingAtMs across probes so the floor is not restarted by polling", () => {
    const { state } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 30 * SEC, micInUse: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true }),
    ]);
    expect(state.micRisingAtMs).toBe(T0);
  });
});

describe("camera and mic together", () => {
  it("emits both edges from one probe", () => {
    const { signals } = poll([
      probe({ atMs: T0, micInUse: true }),
      probe({ atMs: T0 + 61 * SEC, micInUse: true, cameraInUse: true }),
    ]);
    expect(signals).toEqual([
      { kind: "cameraOn", atMs: T0 + 61 * SEC },
      { kind: "micOn", atMs: T0 + 61 * SEC },
    ]);
  });

  it("a camera edge is never delayed by the mic's floor", () => {
    const { signals } = poll([probe({ atMs: T0, micInUse: true, cameraInUse: true })]);
    expect(signals).toEqual([{ kind: "cameraOn", atMs: T0 }]);
  });

  it("starts from a level state with nothing held", () => {
    expect(initialLevels).toEqual({ camera: false, micActive: false, micRisingAtMs: NO_SIGNAL });
  });
});
