/**
 * The seam, end to end, against the FAKE `SignalSource`.
 *
 * No Electron, no Mac, no permission grant. Every clock here is vitest's fake
 * timer clock, so "fifteen minutes later" is arithmetic and runs in microseconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MIN, T0, makeHarness, rows, type Harness } from "../../test/helpers/runtime";
import { countIntervals, readJournal } from "../store";
import { NOT_CONFIGURED } from "./sync-seam";

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  h?.close();
  vi.useRealTimers();
});

/** Advance the clock AND the timers together, so `Date.now()` and the deadline agree. */
function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

describe("a real input event opens an interval and the store has it", () => {
  it("opens on the first key and writes the row at the last real signal", async () => {
    h = await makeHarness();

    expect(h.runtime.liveStatus().state).toBe("idle");
    expect(h.runtime.liveStatus().openedAtMs).toBeNull();

    h.source.key(Date.now());
    const open = h.runtime.liveStatus();
    expect(open.state).toBe("working");
    expect(open.openedAtMs).toBe(T0);
    expect(open.lastSignalKind).toBe("input");
    // Absolute epoch ms, and armed for exactly one idle timeout past the signal.
    expect(open.deadlineMs).toBe(T0 + 15 * MIN);
    // Nothing is stored until the interval CLOSES.
    expect(countIntervals(h.db)).toBe(0);
    // …but the journal already knows where it would be truncated.
    expect(readJournal(h.db)?.lastSignalMs).toBe(T0);

    advance(5 * MIN);
    h.source.key(Date.now(), 3);

    // Idle out.
    advance(16 * MIN);

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    const row = stored[0]!;
    expect(row.started_at_ms).toBe(T0);
    // THE RULE: the end is the LAST REAL SIGNAL, not the moment the countdown
    // fired 16 minutes later, and not now().
    expect(row.ended_at_ms).toBe(T0 + 5 * MIN);
    expect(row.last_signal_at_ms).toBe(row.ended_at_ms);
    expect(row.duration_s).toBe(300);
    expect(row.end_reason).toBe("idle_timeout");
    expect(row.key_events).toBe(4);
    expect(h.runtime.liveStatus().state).toBe("idle");
  });

  it("counts mouse events separately and keeps one interval across a burst", async () => {
    h = await makeHarness();
    for (let i = 0; i < 50; i++) {
      h.source.mouse(Date.now());
      advance(1000);
    }
    expect(h.runtime.liveStatus().openedAtMs).toBe(T0);
    advance(16 * MIN);
    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.mouse_events).toBe(50);
    expect(stored[0]!.ended_at_ms).toBe(T0 + 49_000);
  });
});

/**
 * The idle timeout is a SETTING (PRD §7: "15 minutes, adjustable 10–15"), and a
 * setting that needs a relaunch is one the owner has to be warned about. What
 * must NOT change is the row: the reducer still closes at the last real signal,
 * whatever the timeout is. AGENTS.md, the rule that outranks everything.
 */
describe("changing the idle timeout while an interval is open", () => {
  it("takes effect immediately when shortened, and still closes at the last signal", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    expect(h.runtime.liveStatus().deadlineMs).toBe(T0 + 15 * MIN);

    advance(2 * MIN);
    h.source.key(Date.now());
    const lastSignal = T0 + 2 * MIN;

    h.runtime.setIdleTimeoutMs(10 * MIN);
    // Re-armed from the last real signal rather than left on the old deadline:
    // otherwise a shortened timeout would not be noticed for another five
    // minutes.
    expect(h.runtime.liveStatus().deadlineMs).toBe(lastSignal + 10 * MIN);

    advance(11 * MIN);
    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    // THE END STAMP IS UNCHANGED. Shortening the timeout changes when the app
    // notices, never what it writes.
    expect(stored[0]!.ended_at_ms).toBe(lastSignal);
    expect(stored[0]!.end_reason).toBe("idle_timeout");
  });

  it("lengthening it keeps the session open past the old deadline", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    h.runtime.setIdleTimeoutMs(20 * MIN);

    // Past the original 15 minutes with no input at all.
    advance(16 * MIN);
    expect(h.runtime.liveStatus().state).toBe("working");
    expect(countIntervals(h.db)).toBe(0);

    advance(5 * MIN);
    expect(h.runtime.liveStatus().state).toBe("idle");
    expect(rows(h.db)[0]!.ended_at_ms).toBe(T0);
  });

  it("ignores a value that could not be a timeout, rather than arming nothing", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      h.runtime.setIdleTimeoutMs(bad);
      expect(h.runtime.liveStatus().deadlineMs).toBe(T0 + 15 * MIN);
    }
  });
});

describe("a stamped, synthetic event does NOT open an interval", () => {
  /**
   * AGENTS.md trap #4, the 24-hour-workday bug: if our own jiggle were ever
   * counted as human input, hours would inflate with fake time and nothing
   * anywhere would report an error.
   */
  it("posting a jiggle emits no signal and opens nothing", async () => {
    h = await makeHarness();

    expect(h.source.jiggle()).toBe(true);
    expect(h.source.jiggles).toHaveLength(1); // it really was posted…
    expect(h.runtime.liveStatus().state).toBe("idle"); // …and it changed nothing
    expect(h.runtime.liveStatus().openedAtMs).toBeNull();
    expect(countIntervals(h.db)).toBe(0);
  });

  it("ten minutes of the jiggler running while idle produces zero intervals", async () => {
    h = await makeHarness({ jigglerIntervalMs: 30_000 });

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    advance(10 * MIN);

    // The jiggler really ran…
    expect(h.source.jiggles.length).toBe(20);
    // …and the tracker never noticed, because a jiggle is not a signal.
    expect(h.runtime.liveStatus().state).toBe("idle");
    expect(h.runtime.liveStatus().openedAtMs).toBeNull();
    expect(h.runtime.liveStatus().lastSignalMs).toBeNull();
    expect(countIntervals(h.db)).toBe(0);
    expect(readJournal(h.db)).toBeNull();
  });

  it("the jiggler cannot extend a real interval past its last real signal", async () => {
    h = await makeHarness({ jigglerIntervalMs: 30_000 });
    h.source.key(Date.now());
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });

    // Twenty minutes of jiggling and not one keystroke.
    advance(20 * MIN);

    const stored = rows(h.db);
    // Row 1: the pre-boundary interval. Row 2: the successor, closed on the
    // idle timeout at the boundary timestamp — NOT extended by the jiggles.
    expect(stored.length).toBeGreaterThanOrEqual(1);
    for (const row of stored) expect(row.ended_at_ms).toBeLessThanOrEqual(T0);
    expect(h.runtime.liveStatus().state).toBe("idle");
  });
});

describe("the jiggler toggle is an interval boundary", () => {
  it("closes the current interval, opens a contiguous successor, and both are homogeneous", async () => {
    h = await makeHarness();

    h.source.key(Date.now());
    advance(5 * MIN);
    h.source.key(Date.now());

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });

    // The predecessor is committed and a successor is already open.
    expect(countIntervals(h.db)).toBe(1);
    expect(h.runtime.liveStatus().state).toBe("working");
    expect(h.runtime.liveStatus().openedAtMs).toBe(T0 + 5 * MIN);

    advance(5 * MIN);
    h.source.key(Date.now());
    advance(16 * MIN);

    const stored = rows(h.db);
    expect(stored).toHaveLength(2);
    const [first, second] = stored as [(typeof stored)[0], (typeof stored)[0]];

    // Contiguous: no wall-clock time is lost at the seam.
    expect(first.ended_at_ms).toBe(second.started_at_ms);
    expect(first.end_reason).toBe("jiggler_toggle");

    // HOMOGENEOUS. `jiggler_s` is 0 or the whole duration, never in between:
    // partial coverage cannot survive the cross-machine union merge.
    for (const row of stored) {
      expect([0, row.duration_s]).toContain(row.jiggler_s);
    }
    expect(first.jiggler_s).toBe(0);
    expect(second.jiggler_s).toBe(second.duration_s);
    expect(second.duration_s).toBe(300);
  });

  it("toggling the jiggler back off draws a second boundary, still homogeneous", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    advance(4 * MIN);
    h.source.key(Date.now());
    await h.runtime.setToggle({ key: "jiggler", value: false, source: "tray" });
    advance(4 * MIN);
    h.source.key(Date.now());
    advance(16 * MIN);

    const stored = rows(h.db);
    expect(stored.length).toBe(3);
    for (const row of stored) expect([0, row.duration_s]).toContain(row.jiggler_s);
    // The covered one is the middle interval, wholly covered.
    expect(stored[1]!.jiggler_s).toBe(stored[1]!.duration_s);
    expect(stored[1]!.duration_s).toBe(240);
    expect(stored[2]!.jiggler_s).toBe(0);
  });

  it("toggling while idle writes no row at all — there is no boundary to draw", async () => {
    h = await makeHarness();
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    expect(countIntervals(h.db)).toBe(0);
    await h.runtime.setToggle({ key: "jiggler", value: false, source: "tray" });
    expect(countIntervals(h.db)).toBe(0);
  });

  it("routes through the reducer: the toggle is idempotent for the same value", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    // A second "on" is not a boundary. Two rows here would mean the toggle was
    // being applied by hand rather than dispatched.
    expect(countIntervals(h.db)).toBe(1);
  });
});

/**
 * The safety check, moved off a button and onto the moment it is about it.
 *
 * It proves the event tap can still tell our own synthetic input apart from a
 * person's. If it cannot, our jiggle counts as a human and the app reports
 * twenty-four-hour workdays — silently and plausibly (AGENTS.md trap #4). That
 * risk exists ONLY while the jiggler is running, which is why the check now
 * fires on the switch instead of sitting permanently in Settings.
 */
describe("the jiggler self-test runs when the jiggler is switched on", () => {
  /** Let the fire-and-forget verification settle. It is never awaited in main. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1);
  }

  it("runs the check when the jiggler goes on", async () => {
    h = await makeHarness();
    expect(h.source.selfTestRuns).toBe(0);

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();

    expect(h.source.selfTestRuns).toBe(1);
  });

  it("does not run it when the jiggler goes off", async () => {
    h = await makeHarness();
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();
    await h.runtime.setToggle({ key: "jiggler", value: false, source: "tray" });
    await settle();

    expect(h.source.selfTestRuns).toBe(1);
  });

  it("does not block the toggle on it — setToggle resolves while the check hangs", async () => {
    // THE TIMING RULE. The real `selfTest()` deliberately blocks the tap
    // callback for 2.5 s and takes 6–8 s end to end, and that callback runs on
    // the main run loop. Awaiting it here would freeze the switch the user is
    // holding, which is the one thing this codebase does not do.
    //
    // A check that never finishes at all is the sharpest form of the same
    // question, so the fake simply never settles: if `setToggle` awaited it,
    // this test would hang rather than fail.
    h = await makeHarness();
    h.source.selfTestVerdict = "hang";

    const toggles = await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });

    expect(toggles.jiggler).toBe(true);
    expect(h.source.selfTestRuns).toBe(1);
    // Still in flight, and the app is fully usable meanwhile.
    expect((await h.runtime.doctor()).selfTest).toBeNull();
    expect(h.runtime.liveStatus().degraded).toEqual([]);
  });

  it("does not start a second check while one is still running", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "hang";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await h.runtime.setToggle({ key: "jiggler", value: false, source: "tray" });
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();

    expect(h.source.selfTestRuns).toBe(1);
  });

  it("says NOTHING at all when the check passes", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "pass";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    const changesAfterToggle = h.changes.length;
    await settle();

    // No banner, no tray reason, no dialog, no second push. A pass is invisible.
    expect(h.runtime.liveStatus().degraded).toEqual([]);
    expect(h.changes.length).toBe(changesAfterToggle);
    // …and the jiggler is exactly where the user put it.
    expect(h.runtime.toggles().jiggler).toBe(true);
  });

  it("stops the jiggler and raises the alert when the check FAILS", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "fail";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    expect(h.runtime.toggles().jiggler).toBe(true);
    await settle();

    // Refused: nothing synthetic keeps being posted while the discriminator is
    // broken. This is the whole point of running the check here.
    expect(h.runtime.toggles().jiggler).toBe(false);
    // And it is loud, through the surface that already exists for exactly this.
    expect(h.runtime.liveStatus().degraded).toContain("selftest_failed");
  });

  it("stops the jiggler when the check THROWS — an unrun check is not a pass", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "throw";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();

    expect(h.runtime.toggles().jiggler).toBe(false);
    expect(h.runtime.liveStatus().degraded).toContain("selftest_failed");
  });

  it("clears the alert once a later run passes", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "fail";
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();
    expect(h.runtime.liveStatus().degraded).toContain("selftest_failed");

    h.source.selfTestVerdict = "pass";
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();

    expect(h.runtime.liveStatus().degraded).not.toContain("selftest_failed");
    expect(h.runtime.toggles().jiggler).toBe(true);
  });

  it("does nothing with a verdict that arrives after the app has quit", async () => {
    // The check takes 6–8 seconds; a quit fits inside that easily. Acting on a
    // late verdict would dispatch through the reducer into a database the
    // caller has already closed.
    h = await makeHarness();
    h.source.selfTestVerdict = "fail";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await h.runtime.stop("app_quit");
    await expect(settle()).resolves.toBeUndefined();

    expect(h.runtime.liveStatus().degraded).not.toContain("selftest_failed");
  });

  it("keeps the last result in the doctor report, which is what npm run doctor reads", async () => {
    h = await makeHarness();
    h.source.selfTestVerdict = "fail";

    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    await settle();

    const stored = (await h.runtime.doctor()).selfTest;
    expect(stored?.passed).toBe(false);
    expect(stored?.ranAtMs).toBe(T0);
    expect(stored?.appVersion).toBe("0.0.0-test");
    // Recorded PASS OR FAIL: a store that only kept the good runs would let a
    // green date outlive the failure that replaced it.
    expect(stored?.checks.some((c: { passed: boolean }) => !c.passed)).toBe(true);
  });
});

describe("pause and keep-awake", () => {
  it("pausing closes the open interval at its last signal and stops the jiggler", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(3 * MIN);
    h.source.key(Date.now());
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    const jigglesBefore = h.source.jiggles.length;

    await h.runtime.setToggle({ key: "paused", value: true, source: "tray" });

    expect(h.runtime.liveStatus().state).toBe("paused");
    const stored = rows(h.db);
    expect(stored.at(-1)!.ended_at_ms).toBe(T0 + 3 * MIN);
    advance(5 * MIN);
    expect(h.source.jiggles.length).toBe(jigglesBefore);

    // Input while paused is ignored entirely.
    h.source.key(Date.now());
    expect(h.runtime.liveStatus().openedAtMs).toBeNull();
  });

  it("keep-awake is a power assertion, never a work signal", async () => {
    h = await makeHarness();
    await h.runtime.setToggle({ key: "keepAwake", value: true, source: "tray" });
    expect(h.source.keepAwake).toBe(true);
    expect(h.runtime.toggles().keepAwake).toBe(true);
    // Toggling it did not open an interval: a toggle is not evidence anyone is here.
    expect(h.runtime.liveStatus().state).toBe("idle");
    expect(countIntervals(h.db)).toBe(0);
  });
});

describe("degraded state — a missing permission is never a silent zero", () => {
  it("a revoked keyboard grant becomes a visible degraded state", async () => {
    h = await makeHarness();
    expect(h.runtime.liveStatus().degraded).toEqual([]);

    // Input Monitoring removed in System Settings while the app runs: the tap
    // lives, the keyboard bits are gone, and nothing throws.
    h.source.stripKeyboardBits();
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());

    const status = h.runtime.liveStatus();
    expect(status.degraded).toContain("keyboard_permission_missing");
    expect(h.runtime.permissions().keyboardBitsGranted).toBe(false);
    // The mask is the authority, not the preflight — which still says granted.
    expect(h.runtime.permissions().inputMonitoring).toBe("granted");
    expect(h.runtime.permissions().relaunchRequired).toBe(true);
    expect(h.changes).toContain("permissions");
  });

  it("hours are still reported, so the warning cannot be read as 'zero hours'", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(5 * MIN);
    h.source.key(Date.now());
    advance(16 * MIN);

    h.source.stripKeyboardBits();
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());

    const status = h.runtime.liveStatus();
    expect(status.degraded.length).toBeGreaterThan(0);
    // A degraded app still shows the hours it DID record. Zeroing them would
    // turn a permission problem into a data problem.
    // 5 minutes, rounded to the two decimals the query returns.
    expect(status.closedHoursThisWeek).toBe(0.08);
  });

  it("a dead tap is degraded, and the interval closes at the last trusted signal", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(2 * MIN);
    h.source.key(Date.now());

    h.source.killTap();
    h.runtime.onTapLost(Date.now());

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.end_reason).toBe("tap_lost");
    // Not `now()` — we do not invent the minutes we may have missed.
    expect(stored[0]!.ended_at_ms).toBe(T0 + 2 * MIN);

    h.runtime.onWatchdogTick(h.source.probe(), Date.now());
    expect(h.runtime.liveStatus().degraded).toContain("tap_lost");
  });

  it("missing Accessibility disables the jiggler with a reason rather than lying about it", async () => {
    h = await makeHarness({ start: false });
    h.source.perms = {
      listenEvent: true,
      postEvent: false,
      axTrusted: false,
      listenEventAccess: "granted",
      postEventAccess: "unknown",
    };
    await h.runtime.start();

    const t = h.runtime.toggles();
    expect(t.jigglerAvailable).toBe(false);
    expect(t.jigglerUnavailableReason).toBe("needs Accessibility");
    // Tracking is unaffected, so the menu bar does not wear a warning for it…
    expect(h.runtime.liveStatus().degraded).not.toContain("accessibility_missing");
    // …until the user actually asks for the jiggler and does not get it.
    await h.runtime.setToggle({ key: "jiggler", value: true, source: "tray" });
    expect(h.runtime.liveStatus().degraded).toContain("accessibility_missing");
    expect(h.source.jiggles).toHaveLength(0);
  });
});

describe("crash recovery and power", () => {
  it("sleeping does not close the interval; waking past the deadline closes it at the pre-sleep signal", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(MIN);
    h.source.key(Date.now());
    const lastSignal = Date.now();

    await h.runtime.onSuspend(Date.now());
    expect(countIntervals(h.db)).toBe(0); // sleep closes nothing

    // Lid closed for three hours.
    advance(3 * 60 * MIN);
    await h.runtime.onResume(Date.now(), lastSignal);

    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    // The whole night is not work.
    expect(stored[0]!.ended_at_ms).toBe(lastSignal);
    expect(stored[0]!.duration_s).toBe(60);
  });

  it("a short lid-close keeps one continuous interval", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    await h.runtime.onSuspend(Date.now());
    advance(3 * MIN);
    await h.runtime.onResume(Date.now(), T0);
    expect(countIntervals(h.db)).toBe(0);
    expect(h.runtime.liveStatus().openedAtMs).toBe(T0);
  });

  it("locking the screen does not close the interval — it matches Slack", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    h.runtime.onScreenLock(Date.now());
    advance(2 * MIN);
    expect(countIntervals(h.db)).toBe(0);
    h.runtime.onScreenUnlock(Date.now());
    expect(h.runtime.liveStatus().openedAtMs).toBe(T0);
  });

  it("quit leaves the interval journalled, and the next boot resumes the same id", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(2 * MIN);
    h.source.key(Date.now());
    await h.runtime.stop("app_quit");

    const journal = readJournal(h.db)!;
    expect(journal.lastSignalMs).toBe(T0 + 2 * MIN);
    expect(countIntervals(h.db)).toBe(0);

    // A relaunch inside the idle timeout is one continuous session, not two.
    const { createRuntime } = await import("./runtime");
    const { FakeSignalSource } = await import("../native");
    const second = createRuntime({
      db: h.db,
      source: new FakeSignalSource(),
      machineId: "machine-a",
      appVersion: "0.0.0-test",
      tz: "UTC",
      policy: h.policy,
    });
    advance(30_000);
    await second.start();
    expect(second.liveStatus().openedAtMs).toBe(T0);
    expect(countIntervals(h.db)).toBe(0);
  });
});

describe("live status", () => {
  it("reports null hours before any row exists — '—' is not '0'", async () => {
    h = await makeHarness();
    const s = h.runtime.liveStatus();
    expect(s.closedHoursThisWeek).toBeNull();
    expect(s.closedHoursToday).toBeNull();
  });

  it("never lets the deadline cross as a duration", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    const s = h.runtime.liveStatus();
    // Absolute epoch ms, far larger than any plausible duration.
    expect(s.deadlineMs).toBeGreaterThan(T0);
    expect(s.deadlineMs! - s.lastSignalMs!).toBe(15 * MIN);
  });

  it("debounces the 'signal' change to at most one per second", async () => {
    // A mouse drag is 300 events per second. Fanning every one of them out to
    // the tray and to every window would redraw the menu bar 300 times a second.
    h = await makeHarness();
    h.source.key(Date.now());
    h.changes.length = 0;

    for (let i = 0; i < 300; i++) h.source.mouse(Date.now());
    expect(h.changes.filter((c) => c === "signal")).toHaveLength(1);

    for (let i = 0; i < 300; i++) h.source.mouse(Date.now());
    expect(h.changes.filter((c) => c === "signal")).toHaveLength(1);

    advance(1500);
    h.source.mouse(Date.now());
    expect(h.changes.filter((c) => c === "signal")).toHaveLength(2);
  });
});

describe("flush", () => {
  it("reports honestly that sync is not configured rather than a meaningless green", async () => {
    // No seam attached is the same fact as no Worker URL: the cloud is not
    // reachable and the row is safe in the mirror. `ok: true` here would be a
    // green light for an upload that never happened.
    h = await makeHarness();
    h.source.key(Date.now());
    advance(16 * MIN);
    const res = await h.runtime.flushNow();
    expect(res.ok).toBe(false);
    expect(res.error).toBe(NOT_CONFIGURED);
    expect(res.pendingAfter).toBe(1);
  });

  it("the doctor reports the unconfigured state as a state, not as a failure", async () => {
    h = await makeHarness();
    h.source.key(Date.now());
    advance(16 * MIN);
    const report = await h.runtime.doctor();
    expect(report.sync.configured).toBe(false);
    // Not configured is NOT an error. A fresh install must not wear a red
    // badge for a cloud its owner has not asked for yet.
    expect(report.sync.lastFlushError).toBeNull();
    expect(report.sync.pendingRows).toBe(1);
    // Not a degraded reason either: the tray must not wear a ⚠︎ for it.
    expect(h.runtime.liveStatus().degraded).toEqual([]);
  });
});

// ───────────────────────────────────────────────── the doctor tells the truth

/**
 * WHY THIS BLOCK EXISTS.
 *
 * `doctor()` shipped with SIX fields written as literals: `autostart` (all
 * four), `codesign` (both), `camera.deviceCount: 0`, `db.sizeBytes: 0`,
 * `app.isPackaged: false` and `machine.osVersion: process.platform`. Every one
 * of them looked like a measurement. On the machine that found this, launchd
 * had the agent loaded and running while the report said "not installed", two
 * cameras were attached while it said "0 devices", and the boot log two lines
 * above the JSON said `packaged=true` while the JSON said `false`.
 *
 * A field that cannot change is worse than a missing one: it reads as a
 * diagnosis. So the test is not "the values are right" — it is "the values
 * MOVE". Drive the same code twice with different inputs and require every one
 * of these fields to differ.
 */
describe("no doctor field is a hardcoded constant", () => {
  const AUTOSTART_A = {
    probed: true,
    installed: true,
    loaded: true,
    plistPath: "/Users/a/Library/LaunchAgents/com.bpotter.workweekbuddy.plist",
    execPath: "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy",
    execExists: true,
    execMatchesRunningApp: true,
  };
  const AUTOSTART_B = {
    probed: true,
    installed: false,
    loaded: false,
    plistPath: "/Users/b/Library/LaunchAgents/com.bpotter.workweekbuddy.plist",
    execPath: null,
    execExists: false,
    execMatchesRunningApp: false,
  };

  it("moves every field that used to be frozen", async () => {
    const a = await makeHarness({
      autostart: AUTOSTART_A,
      codesign: { probed: true, designatedRequirementSha256: "aaaa", valid: true },
      isPackaged: true,
      osVersion: "15.3.1",
    });
    // Rows on disk, so `sizeBytes` has something to be non-zero about.
    a.source.key(T0);
    vi.advanceTimersByTime(16 * MIN);
    // The RUNNING app's path: a camera comes up, and the five-minute watchdog
    // is what notices. `doctor()` reports what that tick recorded — it does not
    // take a reading of its own once one exists.
    a.source.cameraDeviceCount = 2;
    a.source.cameraOn = true;
    a.runtime.onWatchdogTick(a.source.probe(), Date.now());
    const ra = await a.runtime.doctor();

    // `start: false` is the `--doctor` shape: the runtime is booted read-only,
    // no tap is installed, and the camera reading is the one `doctor()` takes
    // for itself. Setting the knobs before that read is the only way to change
    // what it sees — which is the proof that it IS a read.
    const b = await makeHarness({
      start: false,
      autostart: AUTOSTART_B,
      codesign: { probed: true, designatedRequirementSha256: "bbbb", valid: false },
      isPackaged: false,
      osVersion: "26.0",
    });
    b.source.cameraDeviceCount = 0;
    b.source.cameraOn = false;
    const rb = await b.runtime.doctor();

    try {
      expect(ra.autostart).toEqual(AUTOSTART_A);
      expect(rb.autostart).toEqual(AUTOSTART_B);
      expect(ra.codesign.designatedRequirementSha256).toBe("aaaa");
      expect(rb.codesign.valid).toBe(false);
      expect(ra.app.isPackaged).toBe(true);
      expect(rb.app.isPackaged).toBe(false);
      expect(ra.machine.osVersion).toBe("15.3.1");
      expect(rb.machine.osVersion).toBe("26.0");
      // "darwin" is a platform, not a version, and is the same string on every
      // Mac ever made. It was the old answer.
      expect(ra.machine.osVersion).not.toBe("darwin");
      expect(ra.camera.deviceCount).toBe(2);
      expect(rb.camera.deviceCount).toBe(0);
      expect(ra.camera.inUse).toBe(true);
      expect(rb.camera.inUse).toBe(false);
      expect(ra.db.sizeBytes).toBeGreaterThan(0);
      // Same code, different machine: the numbers must not be the same number.
      expect(ra.db.sizeBytes).not.toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("says 'nobody looked' rather than 'no' when the seams are absent", async () => {
    // The other half of the rule. A doctor with no way to run `launchctl` must
    // not report `installed: false` — that is the sentence that sent this whole
    // change's debugging in the wrong direction. `probed: false` is the answer.
    h = await makeHarness();
    const report = await h.runtime.doctor();
    expect(report.autostart.probed).toBe(false);
    expect(report.codesign.probed).toBe(false);
    expect(report.codesign.valid).toBeNull();
  });

  it("reads the camera even though --doctor never starts the tap", async () => {
    // THE BUG THIS BLOCK IS NAMED AFTER. `--doctor` boots the runtime read-only
    // and never calls `start()`, so nothing had ever taken a level reading and
    // the report said `deviceCount: 0, inUse: false` on a Mac with two cameras
    // — which is indistinguishable from the App Sandbox failure that empties
    // the CoreMediaIO device list (AGENTS.md #12).
    h = await makeHarness({ start: false });
    h.source.cameraDeviceCount = 2;
    h.source.cameraOn = true;
    const report = await h.runtime.doctor();
    expect(report.camera.probed).toBe(true);
    expect(report.camera.deviceCount).toBe(2);
    expect(report.camera.inUse).toBe(true);
    expect(report.camera.lastReadMs).not.toBeNull();
  });

  it("does not call itself not-green over a tap it never looked at", async () => {
    // `--doctor` installs no tap, so requiring `tap.enabled` made `allGreen`
    // false on every healthy machine, and the doctor script closed every
    // install with "every invariant above holds, but the app reports
    // allGreen=false". A disagreement note that always fires is not one.
    h = await makeHarness({ start: false });
    const report = await h.runtime.doctor();
    expect(report.tap.probed).toBe(false);
    expect(report.allGreen).toBe(true);
  });

  it("still calls itself not-green when a tap it DID look at is dead", async () => {
    h = await makeHarness();
    h.source.tapEnabled = false;
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());
    const report = await h.runtime.doctor();
    expect(report.tap.probed).toBe(true);
    expect(report.allGreen).toBe(false);
  });

  it("does NOT report the tap as probed just because the camera was read", async () => {
    // The other direction, and the one that would have been a regression. A
    // `--doctor` process installs no tap; folding the level read into the tap's
    // status would report `created: false` on every healthy machine and turn
    // `scripts/doctor.ts` red — re-introducing AGENTS.md #16 from the far end.
    h = await makeHarness({ start: false });
    const report = await h.runtime.doctor();
    expect(report.camera.probed).toBe(true);
    expect(report.tap.probed).toBe(false);
    expect(report.tap.grantedMaskHex).toBe("-");
  });
});
