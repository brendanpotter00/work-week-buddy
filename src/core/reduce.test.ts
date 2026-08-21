import { describe, it, expect } from "vitest";

// Imported through the barrel on purpose: it proves src/core/index.ts really
// re-exports the reducer, the levels converter and the types.
import { reduce, initialState, NO_SIGNAL } from "./index";
import type { OpenInterval, Signal, TrackerState } from "./index";

import {
  HOUR,
  MIN,
  T0,
  effectsOf,
  journalled,
  makeConfig,
  run,
} from "../../test/helpers/tracker";

const cfg = makeConfig();

/** A state with one interval already open, started by real input at `T0`. */
function opened(over: Partial<TrackerState> = {}): TrackerState {
  const r = reduce(initialState, { kind: "realInput", atMs: T0, keys: 1, mouse: 0 }, cfg, T0);
  return { ...r.state, ...over };
}

function openInterval(s: TrackerState): OpenInterval {
  if (!s.open) throw new Error("expected an open interval");
  return s.open;
}

// ────────────────────────────────────────────────────── the close rule

describe("the close rule — an interval ends at the last real signal", () => {
  it("closes at the last signal, not at the timeout instant", () => {
    // AGENTS.md, the rule that outranks everything. If this ever regresses,
    // every coffee break silently donates fifteen minutes to the week.
    const firedAt = T0 + 15 * MIN + 3_000;
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: firedAt },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.endedAtMs).toBe(T0);
    expect(persisted[0]!.endedAtMs).not.toBe(firedAt);
    expect(persisted[0]!.endReason).toBe("idle_timeout");
  });

  it("a deadline that fires four hours late still closes at the last real signal", () => {
    // The lid was shut. The timer did not run while the machine was suspended,
    // so it fires at wake. Wake time must not appear anywhere in the row.
    const wakeMs = T0 + 4 * HOUR;
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 3, mouse: 1 },
      { kind: "deadlineFired", atMs: wakeMs },
    ]);
    expect(persisted[0]!.endedAtMs).toBe(T0);
    expect(persisted[0]!.durationS).toBe(0);
  });

  it("a late-delivered event still ends the interval at atMs, not at nowMs", () => {
    // The tap callback was measured at up to 5.4 s of delivery latency under an
    // abusive drain. `atMs` is when the key was actually pressed.
    const pressedAt = T0 + 60_000;
    const deliveredAt = pressedAt + 5_400;
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { sig: { kind: "realInput", atMs: pressedAt, keys: 1, mouse: 0 }, nowMs: deliveredAt },
      { kind: "deadlineFired", atMs: pressedAt + 20 * MIN },
    ]);
    expect(persisted[0]!.endedAtMs).toBe(pressedAt);
    expect(persisted[0]!.endedAtMs).toBeLessThan(deliveredAt);
  });

  it("closing is idempotent — a second deadlineFired persists nothing", () => {
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + 20 * MIN },
      { kind: "deadlineFired", atMs: T0 + 40 * MIN },
    ]);
    expect(persisted).toHaveLength(1);
  });

  it("emits an absolute armDeadline instant, never a duration", () => {
    // AGENTS.md #10. A duration cannot survive sleep.
    const r = reduce(initialState, { kind: "realInput", atMs: T0, keys: 1, mouse: 0 }, cfg, T0);
    const [arm] = effectsOf(r.effects, "armDeadline");
    expect(arm?.atMs).toBe(T0 + cfg.idleTimeoutMs);
    expect(arm?.atMs).toBeGreaterThan(T0);
  });
});

// ────────────────────────────────────────────────────── boot / recovery

describe("boot", () => {
  it("with nothing journalled, cancels the deadline and opens nothing", () => {
    const r = reduce(initialState, { kind: "boot", atMs: T0, journalled: null }, cfg, T0);
    expect(r.state.open).toBeNull();
    expect(effectsOf(r.effects, "cancelDeadline")).toHaveLength(1);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
    expect(effectsOf(r.effects, "tray")[0]?.workingSinceMs).toBeNull();
  });

  it("with a fresh journal, resumes the same interval id", () => {
    // An auto-update restart must not split a six-hour day into two.
    const j = journalled({ lastRealSignalMs: T0 });
    const r = reduce(initialState, { kind: "boot", atMs: T0 + 5 * MIN, journalled: j }, cfg, T0);
    expect(r.state.open?.id).toBe(j.id);
    expect(r.state.open?.startedAtMs).toBe(j.startedAtMs);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
    expect(effectsOf(r.effects, "log")[0]?.event).toBe("resumed");
    expect(effectsOf(r.effects, "armDeadline")[0]?.atMs).toBe(T0 + cfg.idleTimeoutMs);
  });

  it("with a stale journal, closes at the pre-sleep signal and not at wake time", () => {
    // Slept for three hours. Counting the gap would log the whole night.
    const j = journalled({ lastRealSignalMs: T0 });
    const wake = T0 + 3 * HOUR;
    const r = reduce(initialState, { kind: "boot", atMs: wake, journalled: j }, cfg, T0);
    const [persist] = effectsOf(r.effects, "persist");
    expect(persist?.interval.endedAtMs).toBe(T0);
    expect(persist?.interval.endReason).toBe("crash_recovered");
    expect(persist?.interval.id).toBe(j.id);
    expect(r.state.open).toBeNull();
    expect(effectsOf(r.effects, "log")[0]?.detail).toBe(`gap ${wake - T0}ms`);
  });

  it("settles a still-open camera span at the pre-sleep signal, not at wake", () => {
    const j = journalled({
      lastRealSignalMs: T0,
      cameraSinceMs: T0 - 10 * MIN,
      micSinceMs: T0 - 4 * MIN,
      jigglerSinceMs: T0 - 2 * MIN,
    });
    const r = reduce(initialState, { kind: "boot", atMs: T0 + 3 * HOUR, journalled: j }, cfg, T0);
    const closed = effectsOf(r.effects, "persist")[0]!.interval;
    expect(closed.cameraMs).toBe(10 * MIN);
    expect(closed.micMs).toBe(4 * MIN);
    expect(closed.jigglerMs).toBe(2 * MIN);
  });

  it("treats a journal exactly at the timeout boundary as fresh", () => {
    // `stale` is a strict `>`; the boundary belongs to "still working".
    const j = journalled({ lastRealSignalMs: T0 });
    const r = reduce(
      initialState,
      { kind: "boot", atMs: T0 + cfg.idleTimeoutMs, journalled: j },
      cfg,
      T0,
    );
    expect(r.state.open?.id).toBe(j.id);
  });
});

// ────────────────────────────────────────────────────── real input

describe("realInput", () => {
  it("opens an interval at the event timestamp with source 'input'", () => {
    // A fresh config: `newId` is injected precisely so ids are reproducible.
    const fresh = makeConfig();
    const r = reduce(initialState, { kind: "realInput", atMs: T0, keys: 4, mouse: 2 }, fresh, T0);
    const o = openInterval(r.state);
    expect(o.startedAtMs).toBe(T0);
    expect(o.startSource).toBe("input");
    expect(o.lastRealSignalMs).toBe(T0);
    expect(o.lastInputMs).toBe(T0);
    expect(o.keyEvents).toBe(4);
    expect(o.mouseEvents).toBe(2);
    expect(o.id).toBe("id-0");
  });

  it("extends the open interval and accumulates counters", () => {
    const { state } = run([
      { kind: "realInput", atMs: T0, keys: 4, mouse: 2 },
      { kind: "realInput", atMs: T0 + 60_000, keys: 3, mouse: 5 },
    ]);
    const o = openInterval(state);
    expect(o.lastRealSignalMs).toBe(T0 + 60_000);
    expect(o.lastInputMs).toBe(T0 + 60_000);
    expect(o.keyEvents).toBe(7);
    expect(o.mouseEvents).toBe(7);
  });

  it("extends an interval that a camera opened, and starts its input clock", () => {
    const { state } = run([
      { kind: "cameraOn", atMs: T0 },
      { kind: "realInput", atMs: T0 + 3 * MIN, keys: 1, mouse: 0 },
    ]);
    const o = openInterval(state);
    expect(o.startSource).toBe("camera");
    expect(o.lastInputMs).toBe(T0 + 3 * MIN);
    expect(o.lastRealSignalMs).toBe(T0 + 3 * MIN);
  });

  it("never moves a timestamp backwards on an out-of-order event", () => {
    const { state } = run([
      { kind: "realInput", atMs: T0 + 60_000, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
    ]);
    expect(openInterval(state).lastRealSignalMs).toBe(T0 + 60_000);
  });

  it("is ignored entirely while paused", () => {
    const r = reduce(
      { ...initialState, paused: true },
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      cfg,
      T0,
    );
    expect(r.state.open).toBeNull();
    expect(r.effects).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────── camera and mic

describe("camera and mic hold an interval open", () => {
  it("camera-on alone opens an interval after twenty idle minutes", () => {
    const r = reduce(initialState, { kind: "cameraOn", atMs: T0 }, cfg, T0);
    const o = openInterval(r.state);
    expect(o.startSource).toBe("camera");
    expect(o.cameraSinceMs).toBe(T0);
    expect(o.lastInputMs).toBe(NO_SIGNAL);
    expect(r.state.cameraOn).toBe(true);
  });

  it("mic-on alone opens an interval with source 'mic'", () => {
    const r = reduce(initialState, { kind: "micOn", atMs: T0 }, cfg, T0);
    const o = openInterval(r.state);
    expect(o.startSource).toBe("mic");
    expect(o.micSinceMs).toBe(T0);
    expect(o.cameraSinceMs).toBe(NO_SIGNAL);
  });

  it("camera-on holds an interval open past the fifteen-minute deadline", () => {
    // The 50-minute meeting where nobody touches the mouse.
    const { state, persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "cameraOn", atMs: T0 + 60_000 },
      { kind: "deadlineFired", atMs: T0 + 20 * MIN },
    ]);
    expect(persisted).toHaveLength(0);
    expect(state.open).not.toBeNull();
    expect(openInterval(state).lastRealSignalMs).toBe(T0 + 20 * MIN);
  });

  it("a live microphone holds an interval open past the deadline too", () => {
    const { state, persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "micOn", atMs: T0 + 60_000 },
      { kind: "deadlineFired", atMs: T0 + 20 * MIN },
    ]);
    expect(persisted).toHaveLength(0);
    expect(openInterval(state).lastRealSignalMs).toBe(T0 + 20 * MIN);
  });

  it("a mic-only interval still ends at the last real signal, never at the timeout", () => {
    // The close rule, asserted specifically on the path the mic simplification
    // widened. A microphone now opens intervals it never used to open, so the
    // rule that outranks everything gets a case of its own here: the row ends
    // at the mic-off edge, and the instant the countdown fired appears nowhere.
    const micOffAt = T0 + 40 * MIN;
    const firedAt = micOffAt + 15 * MIN + 4_000;
    const { persisted } = run([
      { kind: "micOn", atMs: T0 },
      { kind: "micOff", atMs: micOffAt },
      { kind: "deadlineFired", atMs: firedAt },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.startSource).toBe("mic");
    expect(persisted[0]!.endedAtMs).toBe(micOffAt);
    expect(persisted[0]!.endedAtMs).not.toBe(firedAt);
    expect(persisted[0]!.endReason).toBe("idle_timeout");
  });

  it("camera-on into an open interval starts a span without re-dating the start", () => {
    const { state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "cameraOn", atMs: T0 + 2 * MIN },
    ]);
    const o = openInterval(state);
    expect(o.startedAtMs).toBe(T0);
    expect(o.cameraSinceMs).toBe(T0 + 2 * MIN);
    expect(o.lastRealSignalMs).toBe(T0 + 2 * MIN);
    // Camera is not input: the camera-only cap must still be computable.
    expect(o.lastInputMs).toBe(T0);
  });

  it("a repeated on-edge does not restart an already-running span", () => {
    const { state } = run([
      { kind: "cameraOn", atMs: T0 },
      { kind: "micOn", atMs: T0 + MIN },
      { kind: "cameraOn", atMs: T0 + 2 * MIN },
      { kind: "micOn", atMs: T0 + 3 * MIN },
    ]);
    const o = openInterval(state);
    expect(o.cameraSinceMs).toBe(T0);
    expect(o.micSinceMs).toBe(T0 + MIN);
  });

  it("camera-off folds the span and counts as presence up to that moment", () => {
    const { state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "cameraOn", atMs: T0 + MIN },
      { kind: "cameraOff", atMs: T0 + 31 * MIN },
    ]);
    const o = openInterval(state);
    expect(o.cameraMs).toBe(30 * MIN);
    expect(o.cameraSinceMs).toBe(NO_SIGNAL);
    expect(o.lastRealSignalMs).toBe(T0 + 31 * MIN);
    expect(state.cameraOn).toBe(false);
  });

  it("mic-off folds the mic span and leaves the camera span running", () => {
    const { state } = run([
      { kind: "cameraOn", atMs: T0 },
      { kind: "micOn", atMs: T0 + MIN },
      { kind: "micOff", atMs: T0 + 11 * MIN },
    ]);
    const o = openInterval(state);
    expect(o.micMs).toBe(10 * MIN);
    expect(o.micSinceMs).toBe(NO_SIGNAL);
    expect(o.cameraSinceMs).toBe(T0);
    expect(state.micActive).toBe(false);
    expect(state.cameraOn).toBe(true);
  });

  it("an off-edge with no span running changes no totals", () => {
    const { state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "cameraOff", atMs: T0 + MIN },
      { kind: "micOff", atMs: T0 + 2 * MIN },
    ]);
    const o = openInterval(state);
    expect(o.cameraMs).toBe(0);
    expect(o.micMs).toBe(0);
  });

  it("an off-edge with nothing open only lowers the level", () => {
    const r = reduce({ ...initialState, cameraOn: true }, { kind: "cameraOff", atMs: T0 }, cfg, T0);
    expect(r.state.cameraOn).toBe(false);
    expect(r.state.open).toBeNull();
    expect(r.effects).toHaveLength(0);
  });

  it("while paused, an on-edge sets the level and opens nothing", () => {
    const r = reduce({ ...initialState, paused: true }, { kind: "cameraOn", atMs: T0 }, cfg, T0);
    expect(r.state.cameraOn).toBe(true);
    expect(r.state.open).toBeNull();
    expect(r.effects).toHaveLength(0);

    const r2 = reduce(
      { ...initialState, paused: true },
      { kind: "micOn", atMs: T0 },
      cfg,
      T0,
    );
    expect(r2.state.micActive).toBe(true);
    expect(r2.state.open).toBeNull();
  });
});

// ────────────────────────────────────────────────────── the camera-only cap

describe("the camera-only cap", () => {
  it("closes with end_reason 'camera_cap' once input is older than the cap", () => {
    // A forgotten Zoom, or a virtual camera left running, would otherwise log a
    // fourteen-hour day.
    const start = T0;
    const signals: Signal[] = [
      { kind: "realInput", atMs: start, keys: 1, mouse: 0 },
      { kind: "cameraOn", atMs: start + MIN },
    ];
    // Fire every 15 minutes for seven hours. The camera holds it open until the
    // 6-hour input age is exceeded.
    for (let t = start + 15 * MIN; t <= start + 7 * HOUR; t += 15 * MIN) {
      signals.push({ kind: "deadlineFired", atMs: t });
    }
    const { persisted } = run(signals);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.endReason).toBe("camera_cap");
    // The end is the last fire that still held it — never `now`, never the cap
    // boundary arithmetic.
    expect(persisted[0]!.endedAtMs).toBe(start + 6 * HOUR);
  });

  it("measures the cap from the interval start when there was never any input", () => {
    // Opened by the camera alone: lastInputMs is NO_SIGNAL, so the age is
    // measured from startedAtMs. Using NO_SIGNAL as a timestamp here would
    // make inputAge ≈ 55 years and cap every meeting instantly.
    const r1 = reduce(initialState, { kind: "cameraOn", atMs: T0 }, cfg, T0);
    const r2 = reduce(r1.state, { kind: "deadlineFired", atMs: T0 + 20 * MIN }, cfg, T0);
    expect(r2.state.open).not.toBeNull();

    const r3 = reduce(r2.state, { kind: "deadlineFired", atMs: T0 + 6 * HOUR + MIN }, cfg, T0);
    expect(effectsOf(r3.effects, "persist")[0]?.interval.endReason).toBe("camera_cap");
  });

  it("does not cap while real input keeps arriving", () => {
    const signals: Signal[] = [{ kind: "cameraOn", atMs: T0 }];
    for (let t = T0 + 10 * MIN; t <= T0 + 8 * HOUR; t += 10 * MIN) {
      signals.push({ kind: "realInput", atMs: t, keys: 1, mouse: 0 });
      signals.push({ kind: "deadlineFired", atMs: t + MIN });
    }
    const { persisted, state } = run(signals);
    expect(persisted).toHaveLength(0);
    expect(state.open).not.toBeNull();
  });

  it("does not reopen from a still-held camera after a cap close", () => {
    // A held level is not an edge. Without this the reducer would open/close
    // loop forever at the cap boundary.
    const r1 = reduce(initialState, { kind: "cameraOn", atMs: T0 }, cfg, T0);
    const r2 = reduce(r1.state, { kind: "deadlineFired", atMs: T0 + 7 * HOUR }, cfg, T0);
    expect(r2.state.open).toBeNull();
    expect(r2.state.cameraOn).toBe(true);
    const r3 = reduce(r2.state, { kind: "deadlineFired", atMs: T0 + 8 * HOUR }, cfg, T0);
    expect(r3.state.open).toBeNull();
    expect(effectsOf(r3.effects, "persist")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────── the countdown

describe("deadlineFired", () => {
  it("does nothing when no interval is open", () => {
    const r = reduce(initialState, { kind: "deadlineFired", atMs: T0 }, cfg, T0);
    expect(r.state).toEqual(initialState);
    expect(r.effects).toHaveLength(0);
  });

  it("re-arms instead of closing when a signal arrived after the timer was set", () => {
    // The lazy re-arm: one timer op per timeout, not one per keystroke.
    const { state, effects, persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 10 * MIN, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + 15 * MIN },
    ]);
    expect(persisted).toHaveLength(0);
    expect(state.open).not.toBeNull();
    expect(effectsOf(effects, "armDeadline")[0]?.atMs).toBe(T0 + 10 * MIN + cfg.idleTimeoutMs);
  });

  it("closes exactly at the timeout boundary", () => {
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + cfg.idleTimeoutMs },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.endedAtMs).toBe(T0);
  });

  it("closing cancels the deadline and clears the tray", () => {
    const { effects, state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + 20 * MIN },
    ]);
    expect(effectsOf(effects, "cancelDeadline")).toHaveLength(1);
    expect(effectsOf(effects, "tray")[0]?.workingSinceMs).toBeNull();
    expect(effectsOf(effects, "journal")[0]?.open).toBeNull();
    expect(state.deadlineAtMs).toBeNull();
  });

  it("records duration from start to the last real signal", () => {
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 42 * 60_000 + 400, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + 2 * HOUR },
    ]);
    expect(persisted[0]!.durationS).toBe(2520); // 42 minutes, rounded
  });
});

// ────────────────────────────────────────────────────── jiggler homogeneity

describe("the jiggler toggle is an interval boundary", () => {
  it("toggling produces two intervals, not one", () => {
    const { persisted, state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 5 * MIN, keys: 1, mouse: 0 },
      { kind: "jigglerOn", atMs: T0 + 5 * MIN },
      { kind: "realInput", atMs: T0 + 6 * MIN, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 20 * MIN, keys: 1, mouse: 0 },
      { kind: "jigglerOff", atMs: T0 + 20 * MIN },
    ]);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.endReason).toBe("jiggler_toggle");
    expect(persisted[1]!.endReason).toBe("jiggler_toggle");
    expect(persisted[0]!.id).not.toBe(persisted[1]!.id);
    expect(state.jiggler).toBe(false);
    expect(state.open).toBeNull();
  });

  it("every stored interval is homogeneous — jiggler time is 0 or the whole duration", () => {
    // Partial coverage cannot survive the cross-machine union merge. AGENTS.md.
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 5 * MIN, keys: 1, mouse: 0 },
      { kind: "jigglerOn", atMs: T0 + 5 * MIN },
      { kind: "realInput", atMs: T0 + 6 * MIN, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 20 * MIN, keys: 1, mouse: 0 },
      { kind: "jigglerOff", atMs: T0 + 20 * MIN },
      { kind: "realInput", atMs: T0 + 21 * MIN, keys: 1, mouse: 0 },
      { kind: "deadlineFired", atMs: T0 + 40 * MIN },
    ]);
    expect(persisted).toHaveLength(3);
    for (const iv of persisted) {
      const whole = iv.durationS * 1000;
      const homogeneous = iv.jigglerMs === 0 || Math.abs(iv.jigglerMs - whole) <= 1000;
      expect(homogeneous).toBe(true);
    }
    // And specifically: the middle one is wholly covered, the outer two are not.
    expect(persisted[0]!.jigglerMs).toBe(0);
    expect(persisted[1]!.jigglerMs).toBe(14 * MIN);
    expect(persisted[1]!.durationS).toBe(14 * 60);
    expect(persisted[2]!.jigglerMs).toBe(0);
  });

  it("a toggle with nothing open only records the flag", () => {
    const r = reduce(initialState, { kind: "jigglerOn", atMs: T0 }, cfg, T0);
    expect(r.state.jiggler).toBe(true);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
    expect(effectsOf(r.effects, "log")[0]?.event).toBe("jiggler_on");

    const off = reduce({ ...initialState, jiggler: true }, { kind: "jigglerOff", atMs: T0 }, cfg, T0);
    expect(off.state.jiggler).toBe(false);
    expect(effectsOf(off.effects, "log")[0]?.event).toBe("jiggler_off");
  });

  it("the interval opened while jiggling is covered from its first instant", () => {
    const { state } = run([
      { kind: "jigglerOn", atMs: T0 },
      { kind: "realInput", atMs: T0 + MIN, keys: 1, mouse: 0 },
    ]);
    expect(openInterval(state).jigglerSinceMs).toBe(T0 + MIN);
  });

  it("a synthetic event never reaches the reducer", () => {
    // AGENTS.md #4/#6: if our own jiggle were classified as human input we
    // would log 24-hour workdays, silently. The real filter is isOurs() in
    // src/native/; this asserts the contract the reducer depends on — the only
    // way a jiggle can move lastRealSignalMs is if the filter lets it through.
    const WWB_MAGIC = 0x57574b31;
    const ourPid = 4242;
    const isOurs = (ev: { userData: number; srcPid: number }) =>
      ev.userData === WWB_MAGIC && ev.srcPid === ourPid;

    const tapEvents = [
      { userData: 0, srcPid: 0, atMs: T0 }, // real key press
      { userData: WWB_MAGIC, srcPid: ourPid, atMs: T0 + 10 * MIN }, // our jiggle
      { userData: WWB_MAGIC, srcPid: ourPid, atMs: T0 + 20 * MIN }, // our jiggle
    ];
    const signals: Signal[] = tapEvents
      .filter((ev) => !isOurs(ev))
      .map((ev) => ({ kind: "realInput", atMs: ev.atMs, keys: 1, mouse: 0 }));

    expect(signals).toHaveLength(1);
    const { persisted } = run([...signals, { kind: "deadlineFired", atMs: T0 + 30 * MIN }]);
    expect(persisted[0]!.endedAtMs).toBe(T0);
    expect(persisted[0]!.durationS).toBe(0);
  });
});

// ────────────────────────────────────────────────────── pause

describe("pause", () => {
  it("closes the open interval with reason 'pause'", () => {
    const { persisted, state } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 3 * MIN, keys: 1, mouse: 0 },
      { kind: "pauseOn", atMs: T0 + 4 * MIN },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.endReason).toBe("pause");
    // Even the pause click is not a work signal.
    expect(persisted[0]!.endedAtMs).toBe(T0 + 3 * MIN);
    expect(state.paused).toBe(true);
  });

  it("pausing with nothing open just sets the flag", () => {
    const r = reduce(initialState, { kind: "pauseOn", atMs: T0 }, cfg, T0);
    expect(r.state.paused).toBe(true);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
  });

  it("unpausing opens nothing until the next real signal", () => {
    const { state } = run([
      { kind: "pauseOn", atMs: T0 },
      { kind: "realInput", atMs: T0 + MIN, keys: 1, mouse: 0 },
      { kind: "pauseOff", atMs: T0 + 2 * MIN },
    ]);
    expect(state.paused).toBe(false);
    expect(state.open).toBeNull();

    const resumed = run(
      [{ kind: "realInput", atMs: T0 + 3 * MIN, keys: 1, mouse: 0 }],
      makeConfig(),
      state,
    );
    expect(resumed.state.open?.startedAtMs).toBe(T0 + 3 * MIN);
  });

  it("logs the transition both ways", () => {
    const on = reduce(initialState, { kind: "pauseOn", atMs: T0 }, cfg, T0);
    expect(effectsOf(on.effects, "log")[0]?.event).toBe("pause_on");
    const off = reduce(on.state, { kind: "pauseOff", atMs: T0 }, cfg, T0);
    expect(effectsOf(off.effects, "log")[0]?.event).toBe("pause_off");
  });
});

// ────────────────────────────────────────────────────── tap lost / quit

describe("tapLost and appQuit", () => {
  it("tapLost closes at the last trusted signal", () => {
    // We may have silently missed input. Inventing time is the alternative.
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 4 * MIN, keys: 1, mouse: 0 },
      { kind: "tapLost", atMs: T0 + 9 * MIN },
    ]);
    expect(persisted[0]!.endedAtMs).toBe(T0 + 4 * MIN);
    expect(persisted[0]!.endReason).toBe("tap_lost");
  });

  it("tapLost with nothing open still logs and persists nothing", () => {
    const r = reduce(initialState, { kind: "tapLost", atMs: T0 }, cfg, T0);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
    expect(effectsOf(r.effects, "log")[0]?.event).toBe("tap_lost");
  });

  it("appQuit journals the open interval and persists nothing", () => {
    // The next boot applies the identical staleness rule, so quit needs no
    // special handling and cannot lose the tail.
    const live = run([{ kind: "realInput", atMs: T0, keys: 1, mouse: 0 }]);
    const r = reduce(live.state, { kind: "appQuit", atMs: T0 + MIN }, cfg, T0 + MIN);
    expect(effectsOf(r.effects, "persist")).toHaveLength(0);
    expect(effectsOf(r.effects, "journal")[0]?.open?.id).toBe("id-0");
    expect(r.state.open).not.toBeNull();
  });

  it("appQuit with nothing open journals null", () => {
    const r = reduce(initialState, { kind: "appQuit", atMs: T0 }, cfg, T0);
    expect(effectsOf(r.effects, "journal")[0]?.open).toBeNull();
    expect(effectsOf(r.effects, "log")[0]?.event).toBe("quit");
  });
});

// ────────────────────────────────────────────────────── purity

describe("purity", () => {
  it("does not mutate the state it was handed", () => {
    const before = opened();
    const snapshot = structuredClone(before);
    reduce(before, { kind: "realInput", atMs: T0 + MIN, keys: 9, mouse: 9 }, cfg, T0 + MIN);
    reduce(before, { kind: "cameraOn", atMs: T0 + MIN }, cfg, T0 + MIN);
    reduce(before, { kind: "deadlineFired", atMs: T0 + HOUR }, cfg, T0 + HOUR);
    expect(before).toEqual(snapshot);
  });

  it("never leaks an open span cursor into a stored row", () => {
    // A `…SinceMs` field surviving into a row would put a -1 sentinel, or a
    // half-finished span, into the database. The store's schema has no column
    // for it and would silently drop or reject the write.
    const { persisted } = run([
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "cameraOn", atMs: T0 + MIN },
      { kind: "deadlineFired", atMs: T0 + 8 * HOUR },
    ]);
    const row = persisted[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "cameraMs",
        "durationS",
        "endReason",
        "endedAtMs",
        "id",
        "jigglerMs",
        "keyEvents",
        "lastInputMs",
        "lastRealSignalMs",
        "micMs",
        "mouseEvents",
        "startSource",
        "startedAtMs",
      ].sort(),
    );
  });

  it("ignores nowMs when computing any stored timestamp", () => {
    // Same signals, wildly different processing clocks, identical rows.
    const signals: Signal[] = [
      { kind: "realInput", atMs: T0, keys: 1, mouse: 0 },
      { kind: "realInput", atMs: T0 + 3 * MIN, keys: 2, mouse: 1 },
      { kind: "cameraOn", atMs: T0 + 4 * MIN },
      { kind: "cameraOff", atMs: T0 + 9 * MIN },
      { kind: "deadlineFired", atMs: T0 + 40 * MIN },
    ];
    const a = run(signals.map((sig) => ({ sig, nowMs: sig.atMs })));
    const b = run(signals.map((sig) => ({ sig, nowMs: sig.atMs + 9 * HOUR })));
    expect(a.persisted).toEqual(b.persisted);
  });
});
