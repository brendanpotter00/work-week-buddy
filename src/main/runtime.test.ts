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
    h.source.perms = { listenEvent: true, postEvent: false, axTrusted: false };
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
