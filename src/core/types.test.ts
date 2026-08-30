import { describe, it, expect } from "vitest";
import { NO_SIGNAL, initialState } from "./types";
import { DEFAULTS, IDLE_TIMEOUT_MIN_RANGE, WWB_MAGIC } from "../shared/constants";

describe("core types", () => {
  it("uses a sentinel that cannot collide with a real epoch", () => {
    // 0 is a valid epoch (1970-01-01), so it must never mean "no signal".
    expect(NO_SIGNAL).toBeLessThan(0);
  });

  it("starts with nothing open and no deadline armed", () => {
    expect(initialState.open).toBeNull();
    expect(initialState.deadlineAtMs).toBeNull();
    expect(initialState.paused).toBe(false);
  });
});

describe("constants", () => {
  it("stamps our own events with the verified magic number", () => {
    // Measured on macOS 26.5.1: real input reads back userData=0, ours reads
    // back this value. Changing it silently breaks jiggle filtering.
    expect(WWB_MAGIC).toBe(0x57574b31);
  });

  it("defaults the idle timeout to 15 minutes", () => {
    expect(DEFAULTS.idleTimeoutMs).toBe(900_000);
  });

  it("does not count jiggler time — PRD D1 option (a)", () => {
    expect(DEFAULTS.countJigglerTime).toBe(false);
  });

  it("starts the week on Monday", () => {
    expect(DEFAULTS.weekStart).toBe(1);
  });

  it("keeps a 60-second floor under mic capture", () => {
    // Otherwise a two-second Siri invocation opens a work interval. This is now
    // the ONLY guard on the mic — the meeting-app allowlist and the dictation
    // ignore list are gone (PRD §3.5) — so the number is load-bearing rather
    // than a belt beside a brace.
    expect(DEFAULTS.micMinCaptureMs).toBe(60_000);
  });
});

describe("the idle timeout's adjustable range — PRD §7", () => {
  it("never lets the floor drop below the countable floor", () => {
    // THE WHOLE REASON THE FLOOR IS 2 AND NOT 1.
    //
    // `v_countable` throws away any interval shorter than `minIntervalS`. If
    // the idle timeout could be set below that, the app would decide the owner
    // had stopped working after a gap SHORTER than the shortest stretch of work
    // it is willing to credit — so a burst of real typing would be closed into
    // a row and then filtered straight back out of every headline number, with
    // no error and no way to notice. Two minutes is the smallest whole minute
    // that clears 90 seconds.
    //
    // This is the guard on the interaction, not a restatement of the value: if
    // someone lowers `min` to 1, or raises `minIntervalMs` past two minutes,
    // this fails.
    expect(IDLE_TIMEOUT_MIN_RANGE.min * 60_000).toBeGreaterThanOrEqual(DEFAULTS.minIntervalMs);
  });

  it("keeps the default inside the range it offers", () => {
    // A default outside its own slider is a setting that changes the moment the
    // pane is opened.
    const defaultMin = DEFAULTS.idleTimeoutMs / 60_000;
    expect(defaultMin).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MIN_RANGE.min);
    expect(defaultMin).toBeLessThanOrEqual(IDLE_TIMEOUT_MIN_RANGE.max);
  });

  it("is 2–15, in whole minutes", () => {
    expect(IDLE_TIMEOUT_MIN_RANGE).toEqual({ min: 2, max: 15 });
    expect(Number.isInteger(IDLE_TIMEOUT_MIN_RANGE.min)).toBe(true);
    expect(Number.isInteger(IDLE_TIMEOUT_MIN_RANGE.max)).toBe(true);
  });
});
