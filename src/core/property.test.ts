import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { reduce } from "./reduce";
import { initialState } from "./types";
import type { ClosedInterval, Config, Ms, Signal, TrackerState } from "./types";

/**
 * The property tests. They catch what the transition table misses.
 *
 * The invariant under test is THE rule: a stored interval never ends after the
 * last signal that could have extended it, and its end is always an instant
 * that actually appeared in the signal stream — never a clock reading. If this
 * ever fails, a break donated time to the week, silently and with no error.
 */

const IDLE_TIMEOUT_MS = 900_000;
const CAMERA_ONLY_MAX_MS = 21_600_000;
const START_MS = 1_700_000_000_000;

/** The signal kinds that carry no payload beyond a timestamp. */
const PLAIN_KINDS = [
  "cameraOn",
  "cameraOff",
  "micOn",
  "micOff",
  "jigglerOn",
  "jigglerOff",
  "pauseOn",
  "pauseOff",
  "deadlineFired",
  "tapLost",
  "appQuit",
] as const;

interface Step {
  readonly gapS: number;
  /** 0 selects `realInput`; 1..N select one of PLAIN_KINDS. */
  readonly pick: number;
  readonly keys: number;
  readonly mouse: number;
}

/**
 * A stream description. Timestamps are built by accumulating whole-second gaps,
 * which is what makes the stream monotonic — the same guarantee the event tap
 * gives us, and the precondition the reducer is written against.
 */
const arbGapS = fc.oneof(
  { arbitrary: fc.nat(120), weight: 8 }, // ordinary typing and clicking
  { arbitrary: fc.integer({ min: 121, max: 1_800 }), weight: 1 }, // a break
  { arbitrary: fc.integer({ min: 1_801, max: 30_000 }), weight: 1 }, // lunch, or a night
);

const arbStream = fc.array(
  fc.record({
    gapS: arbGapS,
    pick: fc.nat(PLAIN_KINDS.length),
    keys: fc.nat(5),
    mouse: fc.nat(5),
  }),
  { minLength: 5, maxLength: 200 },
);

/** Streams of only real input and countdown fires — no levels, no toggles. */
const arbInputOnlyStream = fc.array(
  fc.record({
    gapS: fc.nat(1200),
    pick: fc.constantFrom(0, PLAIN_KINDS.indexOf("deadlineFired") + 1),
    keys: fc.nat(5),
    mouse: fc.nat(5),
  }),
  { minLength: 1, maxLength: 120 },
);

function signalAt(step: Step, atMs: Ms): Signal {
  if (step.pick === 0) {
    return { kind: "realInput", atMs, keys: step.keys, mouse: step.mouse };
  }
  const kind = PLAIN_KINDS[step.pick - 1]!;
  return { kind, atMs } as Signal;
}

function makeCfg(): Config {
  let n = 0;
  return {
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    minIntervalMs: 90_000,
    cameraOnlyMaxMs: CAMERA_ONLY_MAX_MS,
    newId: () => `id-${n++}`,
  };
}

interface Trace {
  readonly persisted: readonly ClosedInterval[];
  readonly lastSignalMs: Ms;
}

/**
 * Does this signal carry presence evidence — that is, could it legitimately
 * push an interval's end further out?
 *
 * Derived here from the raw stream and the levels the stream itself implies,
 * with no reference to the reducer's own bookkeeping. That independence is the
 * whole point: this is a second opinion, not a mirror.
 *
 * A countdown firing is evidence ONLY while a camera or a mic meeting is up. A
 * jiggler toggle, a pause, a lost tap and a quit are never evidence — they are
 * reasons to stop, not proof that anyone was there.
 */
function extendsInterval(sig: Signal, levelHeld: boolean): boolean {
  switch (sig.kind) {
    case "realInput":
    case "cameraOn":
    case "cameraOff":
    case "micOn":
    case "micOff":
      return true;
    case "deadlineFired":
      return levelHeld;
    default:
      return false;
  }
}

/**
 * Drive a whole stream, recording — independently of the reducer — every
 * instant at which each interval could legitimately have been extended. That
 * set is the honest upper bound on where the interval may end, and it is also
 * the complete list of values `endedAtMs` is allowed to take.
 */
function drive(steps: readonly Step[]): Trace {
  const cfg = makeCfg();
  let s: TrackerState = initialState;
  let t = START_MS;
  let cameraUp = false;
  let micUp = false;
  const persisted: ClosedInterval[] = [];
  /** id → every instant at which that interval could have been extended. */
  const extendableAt = new Map<string, Set<Ms>>();

  const note = (id: string, at: Ms) => {
    const set = extendableAt.get(id) ?? new Set<Ms>();
    set.add(at);
    extendableAt.set(id, set);
  };

  for (const step of steps) {
    t += step.gapS * 1000;
    const sig = signalAt(step, t);

    // The interval open BEFORE this signal is applied is the one this signal
    // could have extended — but only if the signal is evidence at all.
    if (s.open && extendsInterval(sig, cameraUp || micUp)) note(s.open.id, t);

    if (sig.kind === "cameraOn") cameraUp = true;
    if (sig.kind === "cameraOff") cameraUp = false;
    if (sig.kind === "micOn") micUp = true;
    if (sig.kind === "micOff") micUp = false;

    const r = reduce(s, sig, cfg, t);
    s = r.state;

    // …and an interval that this signal opened starts at this instant.
    if (s.open) note(s.open.id, s.open.startedAtMs);

    for (const fx of r.effects) {
      if (fx.kind !== "persist") continue;
      const iv = fx.interval;
      const allowed = extendableAt.get(iv.id) ?? new Set<Ms>();

      // THE invariant, four ways.
      expect(iv.endedAtMs).toBeGreaterThanOrEqual(iv.startedAtMs);
      expect(iv.endedAtMs).toBeLessThanOrEqual(Math.max(...allowed));
      // The end is an instant that really carried evidence — never a computed
      // one. A `now()`, or the moment a countdown fired with nobody there,
      // would not be in this set.
      expect(allowed.has(iv.endedAtMs)).toBe(true);
      expect(iv.durationS).toBe(Math.round((iv.endedAtMs - iv.startedAtMs) / 1000));
      persisted.push(iv);
    }
  }
  return { persisted, lastSignalMs: t };
}

describe("property: over arbitrary signal streams", () => {
  it("generates streams that actually close intervals — the properties are not vacuous", () => {
    // A property test over streams that never persist anything passes for the
    // wrong reason. This is the tripwire under the four properties below.
    let rows = 0;
    const reasons = new Set<string>();
    fc.assert(
      fc.property(arbStream, (steps) => {
        for (const iv of drive(steps).persisted) {
          rows++;
          reasons.add(iv.endReason);
        }
      }),
      // Seeded: this one is a statement about the GENERATOR, so it must be
      // reproducible. The invariants below stay unseeded on purpose.
      { numRuns: 500, seed: 20_260_819 },
    );
    expect(rows).toBeGreaterThan(500);
    // And every way an interval can end is actually reached.
    expect([...reasons].sort()).toEqual(
      ["camera_cap", "idle_timeout", "jiggler_toggle", "pause", "tap_lost"].sort(),
    );
  });

  it("an interval never ends after the last signal that could have extended it", () => {
    fc.assert(
      fc.property(arbStream, (steps) => {
        drive(steps);
      }),
      { numRuns: 2_000 },
    );
  });

  it("with input and countdowns only, an interval ends at the last keystroke", () => {
    // The sharpest form of the rule, computed entirely outside the reducer:
    // nothing but real input can move the end, so the end IS the last input.
    fc.assert(
      fc.property(arbInputOnlyStream, (steps) => {
        const cfg = makeCfg();
        let s: TrackerState = initialState;
        let t = START_MS;
        let lastInputMs: Ms | null = null;
        for (const step of steps) {
          t += step.gapS * 1000;
          const sig = signalAt(step, t);
          if (sig.kind === "realInput") lastInputMs = t;
          const r = reduce(s, sig, cfg, t);
          s = r.state;
          for (const fx of r.effects) {
            if (fx.kind !== "persist") continue;
            expect(fx.interval.endedAtMs).toBe(lastInputMs);
            expect(fx.interval.endReason).toBe("idle_timeout");
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("intervals never overlap and come out in order", () => {
    fc.assert(
      fc.property(arbStream, (steps) => {
        const { persisted } = drive(steps);
        for (let i = 1; i < persisted.length; i++) {
          expect(persisted[i]!.startedAtMs).toBeGreaterThanOrEqual(persisted[i - 1]!.endedAtMs);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("the summed duration never exceeds the wall-clock span of the stream", () => {
    fc.assert(
      fc.property(arbStream, (steps) => {
        const { persisted, lastSignalMs } = drive(steps);
        const total = persisted.reduce((a, iv) => a + iv.durationS, 0);
        expect(total).toBeLessThanOrEqual(Math.ceil((lastSignalMs - START_MS) / 1000));
      }),
      { numRuns: 300 },
    );
  });

  it("every stored interval is homogeneous in jiggler coverage", () => {
    // Jiggler time is 0 or (within a second of) the whole duration. Partial
    // coverage cannot survive the cross-machine union merge.
    fc.assert(
      fc.property(arbStream, (steps) => {
        for (const iv of drive(steps).persisted) {
          if (iv.jigglerMs === 0) continue;
          expect(Math.abs(iv.jigglerMs - iv.durationS * 1000)).toBeLessThanOrEqual(1000);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("camera and mic totals never exceed the interval they belong to", () => {
    fc.assert(
      fc.property(arbStream, (steps) => {
        for (const iv of drive(steps).persisted) {
          const whole = iv.durationS * 1000;
          expect(iv.cameraMs).toBeGreaterThanOrEqual(0);
          expect(iv.micMs).toBeGreaterThanOrEqual(0);
          expect(iv.cameraMs).toBeLessThanOrEqual(whole);
          expect(iv.micMs).toBeLessThanOrEqual(whole);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a processing clock running a day ahead changes nothing that gets stored", () => {
    // The paranoid restatement of the rule: `nowMs` may be arbitrarily far from
    // the event timestamps and no stored field may move.
    fc.assert(
      fc.property(arbStream, fc.nat(86_400_000), (steps, skewMs) => {
        const rowsAt = (skew: number) => {
          const cfg = makeCfg();
          let s: TrackerState = initialState;
          let t = START_MS;
          const rows: ClosedInterval[] = [];
          for (const step of steps) {
            t += step.gapS * 1000;
            const r = reduce(s, signalAt(step, t), cfg, t + skew);
            s = r.state;
            for (const fx of r.effects) if (fx.kind === "persist") rows.push(fx.interval);
          }
          return rows;
        };
        expect(rowsAt(skewMs)).toEqual(rowsAt(0));
      }),
      { numRuns: 200 },
    );
  });
});
