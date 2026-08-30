/**
 * `MetricsBundle.today` — the number behind the dashboard's "Today" card.
 *
 * The card exists because the owner asked for one ("I see you have an option
 * for total time I've worked this week. I also want a total time that I've
 * worked today"), and the risk it carries is not arithmetic but AGREEMENT: the
 * menu-bar title, the tray dropdown's Today line, the stopwatch card and the
 * stat card are four figures a person reads within seconds of each other, and
 * a tenth of an hour between any two of them is a bug report nobody can close.
 *
 * This file covers the DATABASE half — the union, the policy filters, the
 * timezone and the midnight rollover. That the four figures are one number is
 * pinned where all four can be produced from one real runtime, in
 * `src/main/tray.test.ts` ("is the same number the dashboard's Today card
 * shows"), which is also where `today.hours` is asserted equal to
 * `LiveStatus.closedHoursToday`.
 */
import { describe, expect, it } from "vitest";

import { buildMetrics, WEEK_SERIES_WEEKS } from "./metrics";
import { addDays, DEFAULT_POLICY, hoursOnDate, hoursThisWeek } from "../store";
import { DEFAULT_METRICS_POLICY } from "../shared/ipc-types";
import {
  openTestDb,
  seed,
  seedWeek,
  t,
  NOW_IN_WEEK,
  type RowSpec,
} from "../../test/fakes/seed-db";

const WIRE = DEFAULT_METRICS_POLICY;
const BASE = DEFAULT_POLICY;

describe("MetricsBundle.today", () => {
  it("is the union across machines, not the sum — Monday's overlap counts once", () => {
    const db = openTestDb();
    seedWeek(db);
    // Monday holds personal 09:00–10:00 and work 09:30–10:30. Union = 1.5 h.
    // Summing the two rows would say 2.0 h, and nothing would report an error.
    const m = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-17T18:00:00Z"));
    expect(m.today).toEqual({ date: "2026-08-17", hours: 1.5, prevHours: 0 });
  });

  it("excludes jiggler time and sub-floor bumps exactly as the week does", () => {
    const db = openTestDb();
    seedWeek(db);

    // Wednesday: one 60-second row, under the 90-second stray-bump floor.
    const wed = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-19T18:00:00Z"));
    expect(wed.today.hours).toBe(0);

    // Thursday: four hours, wholly covered by our own jiggler (PRD D1 (a)).
    const thu = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-20T18:00:00Z"));
    expect(thu.today.hours).toBe(0);
    // …and Wednesday, the day before, is 0 for the same reason.
    expect(thu.today.prevHours).toBe(0);

    // The policy knobs reach `today` the same way they reach `week` — through
    // `v_countable`, never through a filter written out again in TypeScript.
    const counted = buildMetrics(
      db,
      { ...WIRE, countJigglerTime: 1 },
      BASE,
      "UTC",
      t("2026-08-20T18:00:00Z"),
    );
    expect(counted.today.hours).toBe(4);
  });

  it("does not count yesterday's interval — the midnight rollover", () => {
    const db = openTestDb();
    // One session, 20:00–23:30 on the 18th. Nothing else has happened yet.
    seed(db, [
      { id: "y", machineId: "work", start: "2026-08-18T20:00:00Z", end: "2026-08-18T23:30:00Z" },
    ]);

    // 23:55 on the 18th: those 3.5 hours are TODAY'S.
    const beforeMidnight = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-18T23:55:00Z"));
    expect(beforeMidnight.today).toEqual({ date: "2026-08-18", hours: 3.5, prevHours: 0 });

    // 00:05 on the 19th — ten minutes later, and the same row. Today is 0 and
    // the 3.5 hours have become yesterday's, with no write and no push in
    // between: the rollover is a property of the QUERY, not of an event.
    const afterMidnight = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-19T00:05:00Z"));
    expect(afterMidnight.today).toEqual({ date: "2026-08-19", hours: 0, prevHours: 3.5 });

    // And the new day accumulates on its own.
    seed(db, [
      { id: "t", machineId: "work", start: "2026-08-19T09:00:00Z", end: "2026-08-19T10:00:00Z" },
    ]);
    const midday = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-19T12:00:00Z"));
    expect(midday.today).toEqual({ date: "2026-08-19", hours: 1, prevHours: 3.5 });
  });

  it("means the OWNER'S local day, not a UTC one", () => {
    const db = openTestDb();
    // 23:30 Chicago on the 18th is 04:30 UTC on the 19th. The row is stamped
    // with the local_date its own zone gives it, and Today has to use the same
    // notion of a day or an evening session lands on tomorrow, silently.
    seed(db, [
      {
        id: "evening",
        machineId: "work",
        start: "2026-08-19T02:00:00Z",
        end: "2026-08-19T04:30:00Z",
        tz: "America/Chicago",
      },
    ]);

    // 22:00 Chicago on the 18th — still the 18th locally, the 19th in UTC.
    const m = buildMetrics(db, WIRE, BASE, "America/Chicago", t("2026-08-19T03:00:00Z"));
    expect(m.today.date).toBe("2026-08-18");
    expect(m.today.hours).toBe(2.5);

    // The same instant read as UTC is a different day and finds nothing.
    const utc = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-19T03:00:00Z"));
    expect(utc.today.date).toBe("2026-08-19");
    expect(utc.today.hours).toBe(0);
  });

  it("is null, not 0, before any row exists — '—' and '0' are different pixels", () => {
    const db = openTestDb();
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(m.today).toEqual({ date: "2026-08-19", hours: null, prevHours: null });
    // Same rule `week` follows, one line above it in the bundle.
    expect(m.week.hours).toBeNull();
  });

  it("yesterday is a CALENDAR day back, across a month boundary", () => {
    const db = openTestDb();
    seed(db, [
      { id: "eom", machineId: "work", start: "2026-08-31T09:00:00Z", end: "2026-08-31T11:00:00Z" },
    ]);
    const m = buildMetrics(db, WIRE, BASE, "UTC", t("2026-09-01T10:00:00Z"));
    expect(m.today.date).toBe("2026-09-01");
    expect(m.today.prevHours).toBe(2);
  });

  it("agrees with the honesty widget's union for the same day", () => {
    const db = openTestDb();
    seedWeek(db);
    const m = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-17T18:00:00Z"));
    // `honesty` is a DIAGNOSTIC — it exists to show union-vs-sum disagreement,
    // which is why the headline figure is its own query rather than a second
    // reader of that field. They must still describe the same day.
    expect(m.honesty.date).toBe(m.today.date);
    expect(m.honesty.unionH).toBe(m.today.hours);
    expect(m.honesty.naiveSumH).toBe(2);
  });
});

/**
 * THE STACK HAS TO COME TO THE BAR.
 *
 * The "This week" bars are stacked per machine now, and the bar is the day's
 * UNION — the same figure the "This week" stat card six inches up the page is
 * built from. A stack summing to anything else would put two contradicting
 * numbers on one screen with nothing anywhere reporting an error, which is
 * exactly what `docs/DATA_MODEL.md` wrote the union merge to prevent.
 *
 * The Monday of `seedWeek()` is the case that breaks the obvious
 * implementation: personal 09:00–10:00 and work 09:30–10:30. Their own totals
 * are an hour each; the day is an hour and a half.
 */
describe("MetricsBundle.weekBars — the per-machine split", () => {
  const sum = (bar: { machines: ReadonlyArray<{ hours: number }> }): number =>
    Math.round(bar.machines.reduce((a, m) => a + m.hours, 0) * 100) / 100;

  it("splits the overlapping day into the UNION, not the sum", () => {
    const db = openTestDb();
    seedWeek(db);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    const mon = m.weekBars[0]!;
    expect(mon.date).toBe("2026-08-17");
    expect(mon.hours).toBe(1.5);
    // Overlap goes to whoever was already working. Personal started at 09:00
    // and keeps its whole hour; work started at 09:30 and is credited only the
    // half hour that reaches past where personal stopped.
    expect(mon.machines).toEqual([
      { machineId: "personal", label: "personal", hours: 1 },
      { machineId: "work", label: "work", hours: 0.5 },
    ]);
    expect(sum(mon)).toBe(1.5);

    // What the obvious implementation would have drawn: each machine's own
    // Monday total, which is the honesty widget's `naive_sum_h` — 2 h of
    // segments in a 1.5 h bar, a third taller than the day it describes.
    const onMonday = buildMetrics(db, WIRE, BASE, "UTC", t("2026-08-17T18:00:00Z"));
    expect(onMonday.honesty.date).toBe("2026-08-17");
    expect(onMonday.honesty.naiveSumH).toBe(2);
    expect(onMonday.honesty.unionH).toBe(mon.hours);
  });

  it("comes to the day's union on every day of the week, overlap or not", () => {
    const db = openTestDb();
    seedWeek(db);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    expect(m.weekBars).toHaveLength(7);
    for (const bar of m.weekBars) {
      // Against `hoursOnDate()` — a DIFFERENT query, the one the Today card
      // uses — so this pins the split against the union itself rather than
      // against the number the split was handed.
      expect(hoursOnDate(db, BASE, bar.date)).toBe(bar.hours);
      expect(sum(bar)).toBe(bar.hours);
    }
    const week = Math.round(m.weekBars.reduce((a, b) => a + b.hours, 0) * 100) / 100;
    expect(week).toBe(m.week.hours);
  });

  it("credits an interval that ran wholly inside another Mac's session zero", () => {
    // The consequence of "whoever was already working", stated out loud.
    // `byMachine` still reports the nested machine's hour.
    const db = openTestDb();
    seed(db, [
      { id: "outer", machineId: "work", start: "2026-08-17T09:00:00Z", end: "2026-08-17T13:00:00Z" },
      {
        id: "inner",
        machineId: "personal",
        start: "2026-08-17T10:00:00Z",
        end: "2026-08-17T11:00:00Z",
      },
    ]);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    const mon = m.weekBars[0]!;
    expect(mon.hours).toBe(4);
    expect(mon.machines).toEqual([
      { machineId: "work", label: "work", hours: 4 },
      { machineId: "personal", label: "personal", hours: 0 },
    ]);
    expect(sum(mon)).toBe(4);
    expect(m.byMachine.find((x) => x.machineId === "personal")?.hours).toBe(1);
  });

  it("holds with three machines, including a three-way overlap", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "alpha", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "b", machineId: "bravo", start: "2026-08-17T09:30:00Z", end: "2026-08-17T11:00:00Z" },
      { id: "c", machineId: "charlie", start: "2026-08-17T09:45:00Z", end: "2026-08-17T12:00:00Z" },
      // Tuesday, disjoint, so one day's ordering is not every day's.
      { id: "d", machineId: "charlie", start: "2026-08-18T09:00:00Z", end: "2026-08-18T10:00:00Z" },
      { id: "e", machineId: "alpha", start: "2026-08-18T14:00:00Z", end: "2026-08-18T15:30:00Z" },
    ]);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    // 09:00–12:00 is one unbroken island: three hours, however many Macs.
    const mon = m.weekBars[0]!;
    expect(mon.hours).toBe(3);
    expect(sum(mon)).toBe(3);

    for (const bar of m.weekBars) {
      expect(hoursOnDate(db, BASE, bar.date)).toBe(bar.hours);
      expect(sum(bar)).toBe(bar.hours);
      // Every bar lists every machine, in ONE order, so the chart's greys do
      // not move from column to column.
      expect(bar.machines.map((x) => x.machineId)).toEqual(m.byMachine.map((x) => x.machineId));
    }
  });

  it("survives one machine, and a week with no machine at all", () => {
    const solo = openTestDb();
    seed(solo, [
      { id: "s", machineId: "only", start: "2026-08-17T09:00:00Z", end: "2026-08-17T17:00:00Z" },
    ]);
    const one = buildMetrics(solo, WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(one.weekBars[0]!.machines).toEqual([{ machineId: "only", label: "only", hours: 8 }]);
    // A day with no hours still lists the machine at 0, which is what keeps the
    // chart's series stable across the week.
    expect(one.weekBars[1]!.machines).toEqual([{ machineId: "only", label: "only", hours: 0 }]);

    const empty = buildMetrics(openTestDb(), WIRE, BASE, "UTC", NOW_IN_WEEK);
    for (const bar of empty.weekBars) {
      expect(bar.hours).toBe(0);
      expect(bar.machines).toEqual([]);
    }
  });

  it("obeys the policy knobs, because it reads `v_countable` like everything else", () => {
    const db = openTestDb();
    seedWeek(db);
    // Thursday is four hours wholly covered by our own jiggler (PRD D1 (a)).
    const off = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(off.weekBars[3]!.hours).toBe(0);
    expect(off.weekBars[3]!.machines.every((x) => x.hours === 0)).toBe(true);

    const on = buildMetrics(db, { ...WIRE, countJigglerTime: 1 }, BASE, "UTC", NOW_IN_WEEK);
    const thu = on.weekBars[3]!;
    expect(thu.hours).toBe(4);
    expect(thu.machines.find((x) => x.machineId === "work")?.hours).toBe(4);
    expect(sum(thu)).toBe(4);
  });

  it("splits a day whose union does not divide into whole hundredths", () => {
    // An hour, then an hour and seven seconds, back to back. The bar rounds;
    // the two shares still have to come to exactly what it rounded to.
    const db = openTestDb();
    seed(db, [
      { id: "p", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "q", machineId: "work", start: "2026-08-17T10:00:00Z", end: "2026-08-17T11:00:07Z" },
    ]);
    const bar = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK).weekBars[0]!;
    expect(sum(bar)).toBe(bar.hours);
    expect(hoursOnDate(db, BASE, bar.date)).toBe(bar.hours);
  });
});

/**
 * `MetricsBundle.weekSeries` — the sixteen bars under the heatmap.
 *
 * The owner asked for it in one sentence: *"I need a way to see how many hours
 * I worked the past few weeks."* Everything below guards one of the two ways a
 * strip like this goes wrong without erroring.
 *
 * 1. IT DISAGREES WITH THE CARD ABOVE IT. The newest bar and the "This week"
 *    stat card describe the same seven days on the same screen. Building the
 *    strip out of `heatmap` — already in the bundle, and it saves sixteen
 *    queries — rounds each DAY to 2dp where `hoursThisWeek()` rounds the WEEK,
 *    and seven rounded days land up to 0.035 h out. That is a different printed
 *    tenth, from a discrepancy nothing reports. So every entry is pinned
 *    against an INDEPENDENT `hoursThisWeek()` call rather than against the loop
 *    that produced it.
 *
 * 2. IT INVENTS WEEKS OFF. `null` (before tracking began — draw nothing) and
 *    `0` (tracked, no work — draw a bar) are different pixels, PRD §4. The
 *    owner has two weeks of history, so fourteen of these sixteen entries are
 *    `null` on his machine today: the empty case IS the case.
 */
describe("MetricsBundle.weekSeries — the sixteen-week strip", () => {
  /** Midweek of `weekStart`, in UTC — an instant no DST shift can move out. */
  const midweek = (weekStart: string): number => t(`${addDays(weekStart, 3)}T12:00:00Z`);

  const p2 = (n: number): string => String(n).padStart(2, "0");

  /** One interval on `date`, `fromH`–`toH` UTC. */
  function day(id: string, date: string, fromH: number, toH: number): RowSpec {
    return {
      id,
      machineId: "work",
      start: `${date}T${p2(fromH)}:00:00Z`,
      end: `${date}T${p2(toH)}:00:00Z`,
    };
  }

  /** Mon–Fri of the week starting `weekStart`, `hoursPerDay` each. */
  function workWeek(weekStart: string, hoursPerDay: number): RowSpec[] {
    return [0, 1, 2, 3, 4].map((i) =>
      day(`${weekStart}-${String(i)}`, addDays(weekStart, i), 9, 9 + hoursPerDay),
    );
  }

  const THIS_WEEK = "2026-08-17";
  const OLDEST_WEEK = addDays(THIS_WEEK, -7 * (WEEK_SERIES_WEEKS - 1));

  it("is sixteen consecutive weeks, oldest first, ending on the current one", () => {
    const db = openTestDb();
    seedWeek(db);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    expect(m.weekSeries).toHaveLength(WEEK_SERIES_WEEKS);
    expect(m.weekSeries.map((w) => w.weekStart)).toEqual(
      Array.from({ length: WEEK_SERIES_WEEKS }, (_, i) => addDays(OLDEST_WEEK, 7 * i)),
    );
    // The newest entry names the week the whole bundle is about.
    expect(m.weekSeries.at(-1)!.weekStart).toBe(m.weekStart);
  });

  it("is `hoursThisWeek()` for every week, pinned against the call itself", () => {
    // Twelve tracked weeks with twelve different totals, so an off-by-one in
    // the walk shows up as a wrong number and not merely a wrong label.
    const db = openTestDb();
    const rows: RowSpec[] = [];
    for (let back = 0; back < 12; back++) {
      rows.push(...workWeek(addDays(THIS_WEEK, -7 * back), 4 + (back % 5)));
    }
    seed(db, rows);

    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    let drawn = 0;
    for (const point of m.weekSeries) {
      if (point.hours === null) continue;
      drawn++;
      // The independent call: a fresh `hoursThisWeek()` at an instant inside
      // that week, reached without going through `buildWeekSeries()` at all.
      expect(point.hours).toBe(hoursThisWeek(db, BASE, "UTC", midweek(point.weekStart)));
    }
    expect(drawn).toBe(12);
  });

  it("does NOT sum the heatmap's already-rounded days", () => {
    // Seven twenty-minute days. Each rounds to 0.33 h on its own; the week is
    // 2.3333 h and rounds to 2.33. Summing the days gives 2.31 — a number the
    // "This week" card never shows, arrived at with nothing throwing.
    const db = openTestDb();
    seed(
      db,
      [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        id: `t${String(i)}`,
        machineId: "work",
        start: `${addDays(THIS_WEEK, i)}T09:00:00Z`,
        end: `${addDays(THIS_WEEK, i)}T09:20:00Z`,
      })),
    );
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    const inWeek = m.heatmap.filter((d) => d.date >= THIS_WEEK && d.date < addDays(THIS_WEEK, 7));
    const summed = Math.round(inWeek.reduce((a, d) => a + d.count, 0) * 100) / 100;

    expect(m.weekSeries.at(-1)!.hours).toBe(2.33);
    expect(m.week.hours).toBe(2.33);
    expect(summed).toBe(2.31);
  });

  it("leaves a week before tracking began `null`, never `0`", () => {
    const db = openTestDb();
    seed(db, workWeek(THIS_WEEK, 7));
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    // Fifteen unobserved weeks and one tracked one. `null` is not `0`: nobody
    // was measuring, so "he worked no hours" is a claim this database cannot
    // make.
    expect(m.weekSeries.slice(0, -1).every((w) => w.hours === null)).toBe(true);
    expect(m.weekSeries.at(-1)!.hours).toBe(35);
    expect(m.allTime.sinceDate).toBe(THIS_WEEK);
  });

  it("draws a tracked week with no work as `0`", () => {
    // Worked four weeks ago and this week; nothing at all in between. Those
    // three weeks ARE zero — he was being measured and he did not work — and
    // the strip has to show them, or a break reads as a hole in the data.
    const db = openTestDb();
    seed(db, [...workWeek(addDays(THIS_WEEK, -28), 8), ...workWeek(THIS_WEEK, 6)]);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);

    const by = new Map(m.weekSeries.map((w) => [w.weekStart, w.hours]));
    expect(by.get(addDays(THIS_WEEK, -28))).toBe(40);
    for (const back of [21, 14, 7]) {
      expect(by.get(addDays(THIS_WEEK, -back))).toBe(0);
    }
    expect(by.get(THIS_WEEK)).toBe(30);
    // …and the weeks before he ever started are still absent, not zero.
    expect(by.get(addDays(THIS_WEEK, -35))).toBeNull();
  });

  it("ends on exactly the number the This week card shows, in every state", () => {
    const db = openTestDb();
    seedWeek(db);
    const m = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(m.weekSeries.at(-1)).toEqual({ weekStart: m.weekStart, hours: m.week.hours });

    // A database with no rows at all: the card reads `—` and so does the strip.
    const empty = buildMetrics(openTestDb(), WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(empty.week.hours).toBeNull();
    expect(empty.weekSeries).toHaveLength(WEEK_SERIES_WEEKS);
    expect(empty.weekSeries.every((w) => w.hours === null)).toBe(true);

    // Rows exist but none of them count — this one is under the 90-second
    // stray-bump floor. `week.hours` is `0` there, so the newest bar has to be
    // `0` too rather than vanishing while the card beside it prints a number.
    const bumps = openTestDb();
    seed(bumps, [
      { id: "b1", machineId: "work", start: "2026-08-17T09:00:00Z", end: "2026-08-17T09:00:30Z" },
    ]);
    const m2 = buildMetrics(bumps, WIRE, BASE, "UTC", NOW_IN_WEEK);
    expect(m2.week.hours).toBe(0);
    expect(m2.weekSeries.at(-1)).toEqual({ weekStart: m2.weekStart, hours: 0 });
  });

  it("obeys the policy knobs the same way the This week card does", () => {
    // `seedWeek()`'s Thursday is four hours wholly covered by our own jiggler.
    const db = openTestDb();
    seedWeek(db);

    const off = buildMetrics(db, WIRE, BASE, "UTC", NOW_IN_WEEK);
    const on = buildMetrics(db, { ...WIRE, countJigglerTime: 1 }, BASE, "UTC", NOW_IN_WEEK);

    expect(off.weekSeries.at(-1)!.hours).toBe(off.week.hours);
    expect(on.weekSeries.at(-1)!.hours).toBe(on.week.hours);
    expect(on.weekSeries.at(-1)!.hours).toBe((off.weekSeries.at(-1)!.hours ?? 0) + 4);
  });

  it("walks CALENDAR weeks across a DST change, not 168-hour blocks", () => {
    // THE TRAP: `nowMs − k × 7 × 86_400_000` is seven 24-HOUR days. Chicago
    // sprang forward on Sunday 8 March 2026, so from 00:30 on Monday 16 March
    // the k=2 anchor lands at 23:30 on Sunday 1 March — inside the week BEFORE
    // the one it is meant to name. The week of 2 March would be missing from
    // the strip, with a full set of sixteen bars and no error anywhere.
    const db = openTestDb();
    seed(db, [day("dst", "2026-03-04", 9, 17)]);

    const now = t("2026-03-16T05:30:00Z"); // 00:30 CDT, a Monday
    const m = buildMetrics(db, WIRE, BASE, "America/Chicago", now);

    expect(m.weekStart).toBe("2026-03-16");
    expect(m.weekSeries.map((w) => w.weekStart)).toEqual(
      Array.from({ length: WEEK_SERIES_WEEKS }, (_, i) =>
        addDays("2026-03-16", 7 * (i - (WEEK_SERIES_WEEKS - 1))),
      ),
    );
    // Every label distinct — no week printed twice, none skipped.
    expect(new Set(m.weekSeries.map((w) => w.weekStart)).size).toBe(WEEK_SERIES_WEEKS);
    // And the week that would have been skipped still carries its hours.
    expect(m.weekSeries.find((w) => w.weekStart === "2026-03-02")?.hours).toBe(8);
  });
});
