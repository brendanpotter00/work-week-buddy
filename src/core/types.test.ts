import { describe, it, expect } from "vitest";
import { NO_SIGNAL, initialState } from "./types";
import { DEFAULTS, WWB_MAGIC } from "../shared/constants";

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
