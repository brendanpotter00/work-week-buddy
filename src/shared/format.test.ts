/**
 * `docs/IMPL_UI.md` §7.1, F01–F11.
 *
 * These formatters are shared by the tray and the dashboard, so a bug here is a
 * bug in two places that then agree with each other — the worst kind.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  creditedOpenMs,
  formatAgo,
  formatAgoMinutes,
  formatCount,
  formatDuration,
  formatHeaderDate,
  formatHours,
  formatStopwatch,
  formatTrayTitle,
  formatDayDelta,
  formatWeekDelta,
  hoursThisWeek,
  hoursToday,
  isHoldCapped,
  isoWeekNumber,
  liveSessionMs,
  localDateString,
  nextIsoWeekStart,
  openIntervalCounts,
  startOfIsoWeek,
  startOfLocalDay,
} from "./format";
import type { LiveStatus, MetricsPolicy } from "./ipc-types";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    asOfMs: T0,
    state: "working",
    openedAtMs: T0,
    lastSignalMs: T0 + 10 * MIN,
    lastSignalKind: "input",
    deadlineMs: T0 + 25 * MIN,
    heldOpenBy: null,
    heldUntilMs: null,
    cameraOn: false,
    micCapturing: false,
    machineId: "m",
    machineLabel: "",
    closedHoursThisWeek: 0,
    closedHoursToday: 0,
    jigglerOnForOpenInterval: false,
    degraded: [],
    ...over,
  };
}

const POLICY: Pick<MetricsPolicy, "countJigglerTime" | "minIntervalS"> = {
  countJigglerTime: 0,
  minIntervalS: 90,
};

describe("creditedOpenMs — the one duration rule", () => {
  it("F01: is lastSignalMs − openedAtMs no matter how far `now` has run ahead", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * 24 * 60 * MIN }), (ahead) => {
        const s = status();
        // The interval is worth ten minutes whether we ask one second later or
        // ten days later. This is the rule that outranks everything.
        expect(creditedOpenMs(s, T0 + 10 * MIN + ahead)).toBe(10 * MIN);
      }),
    );
  });

  it("F02: never credits an interval past a camera hold's own cap", () => {
    const s = status({ heldOpenBy: "camera", heldUntilMs: T0 + 20 * MIN });
    expect(creditedOpenMs(s, T0 + 5 * MIN)).toBe(5 * MIN);
    expect(creditedOpenMs(s, T0 + 99 * MIN)).toBe(20 * MIN);
  });

  it("F03: a camera hold clamps to heldUntilMs", () => {
    const s = status({ heldOpenBy: "camera", heldUntilMs: T0 + 6 * 60 * MIN });
    expect(creditedOpenMs(s, T0 + 8 * 60 * MIN)).toBe(6 * 60 * MIN);
  });

  it("returns 0 when nothing is open", () => {
    expect(creditedOpenMs(status({ openedAtMs: null }), T0)).toBe(0);
  });

  it("falls back to openedAtMs before the first signal is recorded", () => {
    expect(creditedOpenMs(status({ lastSignalMs: null }), T0 + MIN)).toBe(0);
  });
});

describe("liveSessionMs — the stopwatch's wall clock", () => {
  it("is now − openedAtMs, and is deliberately NOT creditedOpenMs", () => {
    // The two answer different questions. This one is "how long has this
    // session been open"; the other is "how much of it will be written".
    const s = status({ lastSignalMs: T0 + MIN });
    expect(liveSessionMs(s, T0 + 9 * MIN)).toBe(9 * MIN);
    expect(creditedOpenMs(s, T0 + 9 * MIN)).toBe(1 * MIN);
  });

  it("is null when nothing is open — '—', never a frozen 0:00:00", () => {
    expect(liveSessionMs(status({ openedAtMs: null }), T0)).toBeNull();
  });

  it("clamps to a camera/mic hold's cap, like creditedOpenMs does", () => {
    const s = status({ heldOpenBy: "camera", heldUntilMs: T0 + 30 * MIN });
    expect(liveSessionMs(s, T0 + 10 * MIN)).toBe(10 * MIN);
    expect(liveSessionMs(s, T0 + 8 * 60 * MIN)).toBe(30 * MIN);
  });

  it("never goes negative, even against a clock that jumped backwards", () => {
    expect(liveSessionMs(status(), T0 - 60 * MIN)).toBe(0);
  });
});

describe("isHoldCapped", () => {
  it("is true only once a capped hold has actually run out of rope", () => {
    const held = status({ heldOpenBy: "camera", heldUntilMs: T0 + 30 * MIN });
    expect(isHoldCapped(held, T0 + 29 * MIN)).toBe(false);
    expect(isHoldCapped(held, T0 + 30 * MIN)).toBe(true);
    // A person typing is not a hold, however long they have been at it.
    expect(isHoldCapped(status(), T0 + 99 * MIN)).toBe(false);
    // An uncapped hold never runs out.
    expect(isHoldCapped(status({ heldOpenBy: "mic", heldUntilMs: null }), T0 + 99 * MIN)).toBe(
      false,
    );
  });
});

describe("hoursToday", () => {
  it("includes the open interval, exactly as hoursThisWeek does", () => {
    // Two totals on one screen that disagree about the last two hours is a
    // support ticket, so they are the same arithmetic over a different base.
    const s = status({ closedHoursToday: 5, closedHoursThisWeek: 33 });
    expect(hoursToday(s, POLICY, T0 + 12 * MIN)).toBe(5.2);
    expect(hoursThisWeek(s, POLICY, T0 + 12 * MIN)).toBe(33.2);
  });

  it("adds zero for a session the jiggler has made uncountable", () => {
    const s = status({ closedHoursToday: 5, jigglerOnForOpenInterval: true });
    expect(hoursToday(s, POLICY, T0 + 12 * MIN)).toBe(5);
  });

  it("is null — not 0 — on a day with no rows and nothing countable open", () => {
    const s = status({ closedHoursToday: null, state: "idle", openedAtMs: null });
    expect(hoursToday(s, POLICY, T0)).toBeNull();
  });
});

describe("openIntervalCounts — will this session survive v_countable?", () => {
  it("says no under the stray-bump floor and yes above it", () => {
    expect(openIntervalCounts(status({ lastSignalMs: T0 + 89_000 }), POLICY, T0 + 89_000)).toBe(
      false,
    );
    expect(openIntervalCounts(status({ lastSignalMs: T0 + 90_000 }), POLICY, T0 + 90_000)).toBe(
      true,
    );
  });

  it("says no while the jiggler is on, unless the policy says otherwise", () => {
    const s = status({ jigglerOnForOpenInterval: true });
    expect(openIntervalCounts(s, POLICY, T0 + 10 * MIN)).toBe(false);
    expect(openIntervalCounts(s, { ...POLICY, countJigglerTime: 1 }, T0 + 10 * MIN)).toBe(true);
  });

  it("says no when nothing is running", () => {
    expect(openIntervalCounts(status({ state: "paused" }), POLICY, T0 + 10 * MIN)).toBe(false);
    expect(
      openIntervalCounts(status({ state: "idle", openedAtMs: null }), POLICY, T0 + 10 * MIN),
    ).toBe(false);
  });
});

describe("hoursThisWeek", () => {
  it("F04: adds ZERO for an open interval the jiggler has made uncountable", () => {
    const s = status({ closedHoursThisWeek: 4, jigglerOnForOpenInterval: true });
    expect(hoursThisWeek(s, POLICY, T0 + 10 * MIN)).toBe(4);
    // …and adds it when the policy says jiggler time counts.
    expect(hoursThisWeek(s, { ...POLICY, countJigglerTime: 1 }, T0 + 10 * MIN)).toBe(4.2);
  });

  it("F05: adds zero when the open interval is under the stray-bump floor", () => {
    const s = status({ closedHoursThisWeek: 4, lastSignalMs: T0 + 30_000 });
    expect(hoursThisWeek(s, POLICY, T0 + 30_000)).toBe(4);
  });

  it("F06: returns null — not 0 — when there is no data and nothing countable is open", () => {
    const s = status({ closedHoursThisWeek: null, state: "idle", openedAtMs: null });
    expect(hoursThisWeek(s, POLICY, T0)).toBeNull();
  });

  it("returns the open interval alone when there is no closed history yet", () => {
    const s = status({ closedHoursThisWeek: null });
    expect(hoursThisWeek(s, POLICY, T0 + 10 * MIN)).toBe(0.2);
  });

  it("adds nothing while paused", () => {
    const s = status({ state: "paused", closedHoursThisWeek: 3 });
    expect(hoursThisWeek(s, POLICY, T0 + 10 * MIN)).toBe(3);
  });
});

describe("display formatters", () => {
  it("F07: null and zero are different pixels", () => {
    expect(formatHours(null)).toBe("—");
    expect(formatHours(0)).toBe("0.0");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(0)).toBe("0");
  });

  it("F11: the tray title", () => {
    expect(formatTrayTitle(36.5, false)).toBe("36.5h");
    expect(formatTrayTitle(null, true)).toBe("—h ⚠︎");
    expect(formatTrayTitle(0, false)).toBe("0.0h");
  });

  it("the stopwatch keeps its digit groups from the first second", () => {
    // MM:SS promoting to H:MM:SS at the hour shifts everything beside it, on a
    // headline number, once per session.
    expect(formatStopwatch(0)).toBe("0:00:00");
    expect(formatStopwatch(7_000)).toBe("0:00:07");
    expect(formatStopwatch(754_000)).toBe("0:12:34");
    expect(formatStopwatch(9_669_000)).toBe("2:41:09");
    expect(formatStopwatch(-5)).toBe("0:00:00");
    // Truncates rather than rounds: a clock must never show a second it has
    // not finished.
    expect(formatStopwatch(1_999)).toBe("0:00:01");
  });

  it("durations and ages", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(41 * MIN)).toBe("41m");
    expect(formatDuration(161 * MIN)).toBe("2h 41m");
    expect(formatDuration(-5)).toBe("0m");
    expect(formatAgo(12_000)).toBe("12s");
    expect(formatAgo(4 * MIN)).toBe("4m");
    expect(formatAgo(2 * 3600_000)).toBe("2h");
  });

  it("the minute-resolution age is a whole phrase, and never a bare zero", () => {
    // The pair mirrors formatStopwatch/formatDuration: seconds where they are
    // information, minutes where the figure just sits on screen. The status
    // strip is the second kind — `test/renderer/last-signal.test.tsx` has the
    // owner's complaint in his own words.
    expect(formatAgoMinutes(0)).toBe("just now");
    expect(formatAgoMinutes(59_000)).toBe("just now");
    expect(formatAgoMinutes(60_000)).toBe("1m ago");
    expect(formatAgoMinutes(119_000)).toBe("1m ago");
    expect(formatAgoMinutes(4 * MIN)).toBe("4m ago");
    expect(formatAgoMinutes(59 * MIN)).toBe("59m ago");
    expect(formatAgoMinutes(60 * MIN)).toBe("1h ago");
    expect(formatAgoMinutes(2 * 3600_000)).toBe("2h ago");
    // Clamped like every other formatter here: a clock that skewed backwards
    // must not render '-1m ago'.
    expect(formatAgoMinutes(-5)).toBe("just now");
    // 'ago' is inside, so a caller appending its own would read 'ago ago'.
    expect(formatAgoMinutes(30_000).endsWith("ago")).toBe(false);
  });

  it("the week delta uses a real minus sign and needs a baseline", () => {
    expect(formatWeekDelta(40, 35.8)).toBe("+4.2h vs last week");
    expect(formatWeekDelta(34.7, 35.8)).toBe("−1.1h vs last week");
    expect(formatWeekDelta(40, null)).toBeNull();
  });

  it("the day delta is the same shape, so the two cards read alike", () => {
    // The Today card sits beside This week, and a sub-line that was
    // structurally different from its neighbour's would read as unfinished.
    expect(formatDayDelta(7.8, 6.6)).toBe("+1.2h vs yesterday");
    expect(formatDayDelta(6.6, 7.8)).toBe("−1.2h vs yesterday");
    // U+2212, not a hyphen: at 12px beside tabular digits a hyphen reads as
    // punctuation rather than as the sign of the number.
    expect(formatDayDelta(6.6, 7.8)?.startsWith("\u2212")).toBe(true);
    // A dead heat is '+0.0', never a bare '0' — the sign is what says which
    // way the comparison ran.
    expect(formatDayDelta(5, 5)).toBe("+0.0h vs yesterday");
    // No baseline, no claim. A first-ever day has no yesterday.
    expect(formatDayDelta(7.8, null)).toBeNull();
    expect(formatDayDelta(null, 6.6)).toBeNull();
  });

  it("the header date carries the ISO week number", () => {
    expect(formatHeaderDate(new Date(2026, 7, 19, 12).getTime())).toMatch(/· week 34$/);
  });
});

describe("calendar arithmetic — local, never UTC", () => {
  it("F09: an evening instant keeps its own local date", () => {
    // 2026-08-19 23:30 local. `toISOString().slice(0,10)` would move every
    // evening interval to the next day, silently, for anyone west of UTC.
    const evening = new Date(2026, 7, 19, 23, 30).getTime();
    expect(localDateString(evening)).toBe("2026-08-19");
  });

  it("F08: startOfIsoWeek is Monday 00:00 local across DST boundaries", () => {
    for (const d of [
      new Date(2026, 2, 8, 12),
      new Date(2026, 2, 9, 12),
      new Date(2026, 10, 1, 12),
      new Date(2026, 10, 2, 12),
    ]) {
      const start = new Date(startOfIsoWeek(d.getTime()));
      expect(start.getDay()).toBe(1);
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
    }
  });

  it("F10: nextIsoWeekStart is always in (now, now + 8 days]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 365 * 24 * 60 * MIN }), (offset) => {
        const now = new Date(2026, 0, 1).getTime() + offset;
        const next = nextIsoWeekStart(now);
        expect(next).toBeGreaterThan(now);
        expect(next - now).toBeLessThanOrEqual(8 * 24 * 60 * MIN);
        expect(new Date(next).getDay()).toBe(1);
      }),
    );
  });

  it("startOfLocalDay is midnight local", () => {
    const d = new Date(startOfLocalDay(new Date(2026, 7, 19, 17, 42).getTime()));
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(19);
  });

  it("isoWeekNumber: 1 January and the Thursday rule", () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1.
    expect(isoWeekNumber(new Date(2026, 0, 1, 12).getTime())).toBe(1);
    expect(isoWeekNumber(new Date(2026, 7, 19, 12).getTime())).toBe(34);
  });
});
