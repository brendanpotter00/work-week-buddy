/**
 * The stopwatch's state machine.
 *
 * Every case here is one where `now − openedAtMs` — the obvious
 * implementation — produces a number that is wrong, or one that is about to be
 * discarded and is therefore a lie while it races ahead. The digits are cheap
 * to get right and expensive to get wrong: a timer that keeps counting through
 * a forgotten Zoom call, or through a jiggler session that `v_countable` throws
 * away, teaches its owner that the app's numbers are decorative.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { stopwatchView, measurementBreaker, traySessionLabel } from "./stopwatch";
import type { DegradedReason, LiveStatus, MetricsPolicy } from "./ipc-types";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60_000;

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    asOfMs: T0,
    state: "working",
    openedAtMs: T0,
    lastSignalMs: T0,
    lastSignalKind: "input",
    deadlineMs: T0 + 15 * MIN,
    heldOpenBy: null,
    heldUntilMs: null,
    cameraOn: false,
    micCapturing: false,
    meetingAppRunning: false,
    machineId: "m",
    machineLabel: "",
    closedHoursThisWeek: 0,
    closedHoursToday: 0,
    jigglerOnForOpenInterval: false,
    degraded: [],
    ...over,
  };
}

/** The owner's real settings: jiggler time does not count. PRD D1 option (a). */
const POLICY: Pick<MetricsPolicy, "countJigglerTime"> = { countJigglerTime: 0 };
const COUNTS_JIGGLER: Pick<MetricsPolicy, "countJigglerTime"> = { countJigglerTime: 1 };

describe("working", () => {
  it("advances once a second, from the snapshot's absolute epoch ms", () => {
    const s = status();
    expect(stopwatchView(s, POLICY, T0 + 7 * SEC).ms).toBe(7 * SEC);
    expect(stopwatchView(s, POLICY, T0 + 8 * SEC).ms).toBe(8 * SEC);
    // Nothing accumulates: a renderer that missed 400 ticks while hidden
    // (AGENTS.md trap #10) still lands on the right number on its next frame.
    expect(stopwatchView(s, POLICY, T0 + 400 * SEC).ms).toBe(400 * SEC);
  });

  it("is a wall clock, so it keeps running past the last keystroke", () => {
    // Deliberately NOT creditedOpenMs(). "How long has this session been open"
    // and "how much of it will be written" are different questions, and the
    // digits answer the first one.
    const s = status({ lastSignalMs: T0 + 1 * MIN });
    expect(stopwatchView(s, POLICY, T0 + 9 * MIN).ms).toBe(9 * MIN);
  });

  it("looks like a confident clock, and says when it started", () => {
    const v = stopwatchView(status(), POLICY, T0 + 30 * SEC);
    expect(v.tone).toBe("running");
    expect(v.label).toBe("Working");
    expect(v.ticking).toBe(true);
    expect(v.confident).toBe(true);
    expect(v.warn).toBe(false);
    expect(v.note).toMatch(/^Started at /);
  });
});

describe("paused", () => {
  it("does not advance, however far `now` has run ahead", () => {
    // pauseOn closes the interval, so this is the defensive half: even a paused
    // snapshot that still carried an open interval is computed from asOfMs.
    const s = status({ state: "paused", asOfMs: T0 + 4 * MIN });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * 24 * 60 * MIN }), (ahead) => {
        expect(stopwatchView(s, POLICY, T0 + 4 * MIN + ahead).ms).toBe(4 * MIN);
      }),
    );
  });

  it("renders as stopped, not as a clock that happens to be still", () => {
    const v = stopwatchView(status({ state: "paused" }), POLICY, T0 + MIN);
    expect(v.tone).toBe("paused");
    expect(v.label).toBe("Paused");
    expect(v.ticking).toBe(false);
    expect(v.confident).toBe(false);
    expect(v.note).toContain("nothing is being recorded");
  });

  it("shows a dash once the pause has closed the interval", () => {
    const v = stopwatchView(status({ state: "paused", openedAtMs: null }), POLICY, T0 + MIN);
    expect(v.ms).toBeNull();
  });
});

describe("idle", () => {
  it("has no digits at all — '—', never a frozen 0:00:00", () => {
    const v = stopwatchView(status({ state: "idle", openedAtMs: null }), POLICY, T0 + MIN);
    expect(v.ms).toBeNull();
    expect(v.tone).toBe("idle");
    expect(v.label).toBe("Idle");
    expect(v.ticking).toBe(false);
    expect(v.confident).toBe(false);
    expect(v.note).toContain("restarts on your next keystroke");
  });

  it("says 'starts' rather than 'restarts' before the very first signal", () => {
    const v = stopwatchView(
      status({ state: "idle", openedAtMs: null, lastSignalMs: null }),
      POLICY,
      T0,
    );
    expect(v.note).toContain("starts on your first keystroke");
  });

  it("says nothing at all before the first snapshot arrives", () => {
    const v = stopwatchView(null, POLICY, T0);
    expect(v.ms).toBeNull();
    expect(v.label).toBe("—");
    expect(v.note.trim()).toBe("");
  });
});

describe("held open by a camera or a meeting mic", () => {
  it("stops at the cap instead of counting a forgotten Zoom all night", () => {
    const s = status({ heldOpenBy: "camera", heldUntilMs: T0 + 30 * MIN });
    expect(stopwatchView(s, POLICY, T0 + 10 * MIN).ms).toBe(10 * MIN);
    expect(stopwatchView(s, POLICY, T0 + 30 * MIN).ms).toBe(30 * MIN);
    // Eight hours later it still reads thirty minutes.
    expect(stopwatchView(s, POLICY, T0 + 8 * 60 * MIN).ms).toBe(30 * MIN);
  });

  it("stops TICKING at the cap, so the digits are not merely repeating", () => {
    const s = status({ heldOpenBy: "mic", heldUntilMs: T0 + 30 * MIN });
    const before = stopwatchView(s, POLICY, T0 + 29 * MIN);
    expect(before.tone).toBe("held");
    expect(before.ticking).toBe(true);
    expect(before.confident).toBe(true);

    const after = stopwatchView(s, POLICY, T0 + 31 * MIN);
    expect(after.tone).toBe("capped");
    expect(after.ticking).toBe(false);
    expect(after.confident).toBe(false);
    expect(after.label).toBe("Capped");
    expect(after.note).toContain("meeting mic cap");
  });

  it("names the cap in the same units as the digits it is watching", () => {
    const s = status({ heldOpenBy: "camera", heldUntilMs: T0 + 45 * MIN });
    expect(stopwatchView(s, POLICY, T0 + 5 * MIN).note).toBe(
      "Held open by the camera — the clock stops at 0:45:00.",
    );
  });

  it("does not invent a cap when the hold has none", () => {
    // `(heldUntilMs ?? openedAtMs) − openedAtMs` is zero, which reads as
    // "capped at 0:00:00" on a clock that is visibly still running.
    const s = status({ heldOpenBy: "camera", heldUntilMs: null });
    const v = stopwatchView(s, POLICY, T0 + 5 * MIN);
    expect(v.tone).toBe("held");
    expect(v.ms).toBe(5 * MIN);
    expect(v.note).not.toContain("0:00:00");
    expect(v.note).toContain("rather than by you");
  });
});

describe("the jiggler, with countJigglerTime: 0", () => {
  it("refuses to look like a clock that is banking hours", () => {
    const v = stopwatchView(status({ jigglerOnForOpenInterval: true }), POLICY, T0 + 20 * MIN);
    expect(v.tone).toBe("uncounted");
    expect(v.label).toBe("Not counted");
    expect(v.confident).toBe(false);
    expect(v.note).toContain("will not count toward your hours");
    // The elapsed time is still true and still moves — it is the CLAIM that it
    // is being banked that would be false.
    expect(v.ms).toBe(20 * MIN);
    expect(v.ticking).toBe(true);
  });

  it("is an ordinary running clock when the policy does count jiggler time", () => {
    const v = stopwatchView(
      status({ jigglerOnForOpenInterval: true }),
      COUNTS_JIGGLER,
      T0 + 20 * MIN,
    );
    expect(v.tone).toBe("running");
    expect(v.confident).toBe(true);
  });

  it("still respects a camera cap while the jiggler is on", () => {
    const s = status({
      jigglerOnForOpenInterval: true,
      heldOpenBy: "camera",
      heldUntilMs: T0 + 30 * MIN,
    });
    const v = stopwatchView(s, POLICY, T0 + 90 * MIN);
    expect(v.ms).toBe(30 * MIN);
    expect(v.ticking).toBe(false);
  });
});

describe("degraded", () => {
  const BREAKS: DegradedReason[] = [
    "keyboard_permission_missing",
    "tap_lost",
    "relaunch_required",
    "db_unwritable",
  ];
  const DOES_NOT_BREAK: DegradedReason[] = [
    "accessibility_missing",
    "sync_silent_72h",
    "fingerprint_mismatch",
  ];

  it.each(BREAKS)("%s takes the confidence off the number", (reason) => {
    const v = stopwatchView(status({ degraded: [reason] }), POLICY, T0 + 12 * MIN);
    expect(v.tone).toBe("degraded");
    expect(v.label).toBe("Unverified");
    expect(v.confident).toBe(false);
    expect(v.warn).toBe(true);
    // A sentence naming THIS reason, not a generic one.
    expect(v.note.length).toBeGreaterThan(20);
    expect(measurementBreaker(status({ degraded: [reason] }))).toBe(reason);
  });

  it.each(DOES_NOT_BREAK)("%s leaves the session clock alone", (reason) => {
    // Muting a correct number because the cloud is unhappy, or because the
    // JIGGLER cannot post, teaches the reader to ignore the ⚠︎ everywhere else.
    const v = stopwatchView(status({ degraded: [reason] }), POLICY, T0 + 12 * MIN);
    expect(v.tone).toBe("running");
    expect(v.confident).toBe(true);
    expect(v.warn).toBe(false);
    expect(measurementBreaker(status({ degraded: [reason] }))).toBeNull();
  });

  it("picks the first breaker, so severity order survives", () => {
    const s = status({ degraded: ["accessibility_missing", "tap_lost", "db_unwritable"] });
    expect(measurementBreaker(s)).toBe("tap_lost");
  });

  it("still shows the elapsed time, because the session really did open then", () => {
    const v = stopwatchView(status({ degraded: ["tap_lost"] }), POLICY, T0 + 12 * MIN);
    expect(v.ms).toBe(12 * MIN);
  });
});

describe("precedence", () => {
  it("a pause outranks everything else that could be wrong", () => {
    const s = status({
      state: "paused",
      degraded: ["tap_lost"],
      jigglerOnForOpenInterval: true,
      heldOpenBy: "camera",
      heldUntilMs: T0 + MIN,
    });
    expect(stopwatchView(s, POLICY, T0 + 5 * MIN).tone).toBe("paused");
  });

  it("a broken signal outranks a jiggler caveat", () => {
    const s = status({ degraded: ["keyboard_permission_missing"], jigglerOnForOpenInterval: true });
    expect(stopwatchView(s, POLICY, T0 + MIN).tone).toBe("degraded");
  });

  it("a jiggler caveat outranks a camera hold", () => {
    const s = status({
      jigglerOnForOpenInterval: true,
      heldOpenBy: "camera",
      heldUntilMs: T0 + 30 * MIN,
    });
    expect(stopwatchView(s, POLICY, T0 + MIN).tone).toBe("uncounted");
  });

  it("every tone is distinguishable from a healthy running clock", () => {
    const running = stopwatchView(status(), POLICY, T0 + MIN);
    const others = [
      stopwatchView(status({ state: "paused" }), POLICY, T0 + MIN),
      stopwatchView(status({ state: "idle", openedAtMs: null }), POLICY, T0 + MIN),
      stopwatchView(status({ jigglerOnForOpenInterval: true }), POLICY, T0 + MIN),
      stopwatchView(status({ degraded: ["tap_lost"] }), POLICY, T0 + MIN),
      stopwatchView(
        status({ heldOpenBy: "camera", heldUntilMs: T0 + 30 * SEC }),
        POLICY,
        T0 + MIN,
      ),
    ];
    for (const v of others) {
      expect(v.tone).not.toBe(running.tone);
      expect(v.label).not.toBe(running.label);
      expect(v.confident).toBe(false);
    }
  });
});

describe("an interval boundary", () => {
  it("resets the digits rather than carrying the old session forward", () => {
    const open = status();
    expect(stopwatchView(open, POLICY, T0 + 40 * MIN).ms).toBe(40 * MIN);

    // idle_timeout closes it…
    const closed = status({ state: "idle", openedAtMs: null, lastSignalMs: T0 + 40 * MIN });
    expect(stopwatchView(closed, POLICY, T0 + 55 * MIN).ms).toBeNull();

    // …and the next keystroke opens a new one, at zero.
    const reopened = status({ openedAtMs: T0 + 60 * MIN, lastSignalMs: T0 + 60 * MIN });
    expect(stopwatchView(reopened, POLICY, T0 + 60 * MIN + 3 * SEC).ms).toBe(3 * SEC);
  });
});

describe("the tray's interval line", () => {
  it("is the dashboard's label and the dashboard's digits, exactly", () => {
    const s = status({ lastSignalMs: T0 + MIN });
    expect(traySessionLabel(s, POLICY, T0 + 2 * 3600_000 + 41 * MIN + 9 * SEC)).toBe(
      "Working · 2:41:09",
    );
  });

  it("carries the caveat into the menu bar too", () => {
    expect(traySessionLabel(status({ jigglerOnForOpenInterval: true }), POLICY, T0 + MIN)).toBe(
      "Not counted · 0:01:00",
    );
    expect(traySessionLabel(status({ degraded: ["tap_lost"] }), POLICY, T0 + MIN)).toBe(
      "Unverified · 0:01:00",
    );
    expect(
      traySessionLabel(
        status({ heldOpenBy: "camera", heldUntilMs: T0 + 30 * SEC }),
        POLICY,
        T0 + MIN,
      ),
    ).toBe("Capped · 0:00:30");
  });

  it("is a bare word when there is nothing running", () => {
    expect(traySessionLabel(status({ state: "idle", openedAtMs: null }), POLICY, T0)).toBe("Idle");
    expect(traySessionLabel(status({ state: "paused", openedAtMs: null }), POLICY, T0)).toBe(
      "Paused",
    );
  });
});
