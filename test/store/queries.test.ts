/**
 * The six metric queries, against a seeded database, with every expected number
 * computed by hand from the fixture in `test/fakes/seed-db.ts`:
 *
 *   Mon 2026-08-17  personal 09:00–10:00   1 h
 *   Mon 2026-08-17  work     09:30–10:30   1 h, 1800 s of camera
 *   Tue 2026-08-18  personal 13:00–14:00   1 h
 *   Wed 2026-08-19  personal 09:00–09:01   60 s   (under the 90 s floor)
 *   Thu 2026-08-20  work     08:00–12:00   4 h    (wholly jiggler-covered)
 *
 * Countable: three intervals. Union across machines: Monday is 09:00–10:30.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../../src/store/policy";
import {
  avgIntervalAllTime,
  avgIntervalThisWeek,
  byMachine,
  heatmap,
  hoursOnDate,
  hoursThisWeek,
  longestInterval,
  machineDaySlices,
  unionVsSum,
} from "../../src/store/queries";
import { upsertMachine } from "../../src/store/sync-state";
import { openTestDb, seed, seedWeek, t, NOW_IN_WEEK } from "../fakes/seed-db";

const P = DEFAULT_POLICY;

describe("metrics", () => {
  it("1) hours this week — Monday's overlap counts once", () => {
    const db = openTestDb();
    seedWeek(db);
    // 1.5 h (Mon union) + 1.0 h (Tue) = 2.5 h. The naive sum would say 3.5.
    expect(hoursThisWeek(db, P, "UTC", NOW_IN_WEEK)).toBe(2.5);
  });

  it("1b) hours this week is 0 when the week holds nothing", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(hoursThisWeek(db, P, "UTC", t("2026-09-07T12:00:00Z"))).toBe(0);
  });

  it("1c) hours on one day — the two Macs' overlap counts once, not twice", () => {
    const db = openTestDb();
    seedWeek(db);
    // Monday holds personal 09:00–10:00 and work 09:30–10:30. The union is
    // 09:00–10:30 = 1.5 h. A SUM(duration_s) would say 2.0 h — a 33% overcount
    // out of one half-hour of two Macs being awake at the same time, which is
    // the whole reason this reads v_merged_day.
    expect(hoursOnDate(db, P, "2026-08-17")).toBe(1.5);
    expect(hoursOnDate(db, P, "2026-08-18")).toBe(1);
  });

  it("1d) hours on one day — the same v_countable filters the week uses", () => {
    const db = openTestDb();
    seedWeek(db);
    // Wednesday's only row is 60 s, under the 90 s stray-bump floor.
    expect(hoursOnDate(db, P, "2026-08-19")).toBe(0);
    // Thursday's only row is four hours WHOLLY covered by our own jiggler.
    expect(hoursOnDate(db, P, "2026-08-20")).toBe(0);
    // Both come back the moment policy says they should — proof the filters
    // arrive through policyCte() rather than being hand-rolled here.
    expect(hoursOnDate(db, { ...P, minIntervalS: 30 }, "2026-08-19")).toBe(0.02);
    expect(hoursOnDate(db, { ...P, countJigglerTime: true }, "2026-08-20")).toBe(4);
  });

  it("1e) hours on one day — an empty day is 0, and days do not bleed into each other", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(hoursOnDate(db, P, "2026-08-16")).toBe(0);
    expect(hoursOnDate(db, P, "2026-09-09")).toBe(0);
  });

  it("1f) hours on one day — the days of a week sum to what the week reports", () => {
    const db = openTestDb();
    seedWeek(db);
    // 1.5 (Mon) + 1.0 (Tue) + 0 + 0 = 2.5, which is query 1's answer for the
    // same week. "Today" and "This week" cannot be built on different rules.
    const days = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"];
    const total = days.reduce((a, d) => a + hoursOnDate(db, P, d), 0);
    expect(total).toBe(hoursThisWeek(db, P, "UTC", NOW_IN_WEEK));
  });

  it("2) average interval length — over raw intervals, not merged islands", () => {
    const db = openTestDb();
    seedWeek(db);
    // (3600 + 3600 + 3600) / 3 = 3600 s = 60.0 min. Merging would have said
    // two "intervals" of 1.5 h and 1 h.
    expect(avgIntervalThisWeek(db, P, "UTC", NOW_IN_WEEK)).toEqual({ minutes: 60, n: 3 });
    expect(avgIntervalAllTime(db, P)).toEqual({ minutes: 60, n: 3 });
  });

  it("2b) average interval length counts the grace window", () => {
    const db = openTestDb();
    seedWeek(db);
    const graced: Policy = { ...P, graceS: 60 };
    expect(avgIntervalThisWeek(db, graced, "UTC", NOW_IN_WEEK)).toEqual({ minutes: 61, n: 3 });
  });

  it("3) longest — the merged session beats the longest single interval", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(longestInterval(db, P)).toEqual({
      kind: "merged_session",
      hours: 1.5,
      localDate: "2026-08-17",
      machineId: null,
    });
  });

  it("3b) longest — a single interval wins when nothing merges", () => {
    const db = openTestDb();
    seed(db, [
      { id: "long", machineId: "work", start: "2026-08-18T08:00:00Z", end: "2026-08-18T11:00:00Z" },
      { id: "short", machineId: "personal", start: "2026-08-18T13:00:00Z", end: "2026-08-18T14:00:00Z" },
    ]);
    expect(longestInterval(db, P)).toEqual({
      kind: "single_interval",
      hours: 3,
      localDate: "2026-08-18",
      machineId: "work",
    });
  });

  it("3c) longest is null when nothing is countable", () => {
    const db = openTestDb();
    seed(db, [
      { id: "bump", machineId: "personal", start: "2026-08-18T08:00:00Z", end: "2026-08-18T08:00:30Z" },
    ]);
    expect(longestInterval(db, P)).toBeNull();
  });

  it("4) heatmap — one row per local day, with levels", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(heatmap(db, P, "UTC", NOW_IN_WEEK)).toEqual([
      { date: "2026-08-17", count: 1.5, level: 0 },
      { date: "2026-08-18", count: 1, level: 0 },
    ]);
    // levelStepH is policy, and it is inlined through the numeric whitelist.
    const fine: Policy = { ...P, levelStepH: 0.5 };
    expect(heatmap(db, fine, "UTC", NOW_IN_WEEK)).toEqual([
      { date: "2026-08-17", count: 1.5, level: 3 },
      { date: "2026-08-18", count: 1, level: 2 },
    ]);
  });

  it("4b) heatmap stops at 371 days back", () => {
    const db = openTestDb();
    seed(db, [
      { id: "old", machineId: "personal", start: "2025-08-01T09:00:00Z", end: "2025-08-01T10:00:00Z" },
      { id: "new", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    // 2026-08-19 minus 371 days is 2025-08-13, so the 2025-08-01 row is out.
    expect(heatmap(db, P, "UTC", NOW_IN_WEEK).map((d) => d.date)).toEqual(["2026-08-17"]);
  });

  it("4c) heatmap levels cap at 4", () => {
    const db = openTestDb();
    seed(db, [
      { id: "marathon", machineId: "personal", start: "2026-08-17T06:00:00Z", end: "2026-08-17T20:00:00Z" },
    ]);
    expect(heatmap(db, P, "UTC", NOW_IN_WEEK)).toEqual([
      { date: "2026-08-17", count: 14, level: 4 },
    ]);
  });

  it("5) per-machine breakdown — a plain sum, because one machine cannot overlap itself", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)).toEqual([
      {
        machineId: "personal",
        label: "personal",
        hours: 2,
        intervals: 2,
        meetingHours: 0,
        jigglerHours: 0,
      },
      { machineId: "work", label: "work", hours: 1, intervals: 1, meetingHours: 0.5, jigglerHours: 0 },
    ]);
  });

  it("5b) a machine with no heartbeat row still appears, labelled by its id", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "unseen-mac", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    // An inner join here would make this machine's hours vanish silently until
    // its heartbeat had been pulled.
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)).toEqual([
      {
        machineId: "unseen-mac",
        label: "unseen-mac",
        hours: 1,
        intervals: 1,
        meetingHours: 0,
        jigglerHours: 0,
      },
    ]);
    upsertMachine(db, { machineId: "unseen-mac", label: "the loft mini", lastSeenMs: NOW_IN_WEEK });
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)[0]?.label).toBe("the loft mini");

    // A later heartbeat that carries no label must not erase the one we have.
    upsertMachine(db, { machineId: "unseen-mac", lastSeenMs: NOW_IN_WEEK + 60_000 });
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)[0]?.label).toBe("the loft mini");
    // And an out-of-order one cannot move last_seen_ms backwards.
    upsertMachine(db, { machineId: "unseen-mac", lastSeenMs: 1 });
    expect(
      db.prepare("SELECT last_seen_ms FROM machine WHERE machine_id = 'unseen-mac'").get(),
    ).toMatchObject({ last_seen_ms: NOW_IN_WEEK + 60_000 });
  });

  it("6) the honesty widget shows both numbers", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(unionVsSum(db, P, "2026-08-17")).toEqual({ naiveSumH: 2, unionH: 1.5 });
    expect(unionVsSum(db, P, "2026-08-18")).toEqual({ naiveSumH: 1, unionH: 1 });
    expect(unionVsSum(db, P, "2026-08-19")).toEqual({ naiveSumH: 0, unionH: 0 });
  });
});

describe("week boundaries come from the display timezone, not from SQLite", () => {
  it("moves the window when the display zone crosses into the next week", () => {
    const db = openTestDb();
    seedWeek(db);
    const sundayNight = t("2026-08-23T23:00:00Z");
    // Still Sunday in UTC: the whole fixture week is in scope.
    expect(hoursThisWeek(db, P, "UTC", sundayNight)).toBe(2.5);
    // Already Monday 08:00 in Tokyo: a brand-new week, and it is empty.
    expect(hoursThisWeek(db, P, "Asia/Tokyo", sundayNight)).toBe(0);
  });

  it("uses Sunday as the week start when policy says so", () => {
    const db = openTestDb();
    seed(db, [
      { id: "sun", machineId: "personal", start: "2026-08-16T09:00:00Z", end: "2026-08-16T10:00:00Z" },
      { id: "mon", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    expect(hoursThisWeek(db, P, "UTC", NOW_IN_WEEK)).toBe(1);
    const sundayStart: Policy = { ...P, weekStart: 0 };
    expect(hoursThisWeek(db, sundayStart, "UTC", NOW_IN_WEEK)).toBe(2);
  });
});

/**
 * 5b) The union SPLIT — query 5's sibling, and not query 5.
 *
 * The property that matters is one line long: **for every day, the slices add
 * up to `hoursOnDate()`**. Everything the stacked bar chart claims rests on it,
 * so it is asserted against the independent union query rather than against
 * anything this function computes for itself.
 */
describe("5b) per-machine, per-day — the union split", () => {
  const H = 3_600_000;
  const msOn = (
    slices: ReturnType<typeof machineDaySlices>,
    date: string,
  ): number => slices.filter((s) => s.localDate === date).reduce((a, s) => a + s.ms, 0);

  it("credits overlap to whichever Mac was already working", () => {
    const db = openTestDb();
    seedWeek(db);
    const slices = machineDaySlices(db, P, "2026-08-17", "2026-08-24");

    expect(slices.filter((s) => s.localDate === "2026-08-17")).toEqual([
      // personal 09:00–10:00 started first and keeps all of it…
      { localDate: "2026-08-17", machineId: "personal", ms: 1 * H },
      // …so work 09:30–10:30 is credited only 10:00–10:30.
      { localDate: "2026-08-17", machineId: "work", ms: 0.5 * H },
    ]);
  });

  it("adds up to the day's union, which is the whole contract", () => {
    const db = openTestDb();
    seedWeek(db);
    const slices = machineDaySlices(db, P, "2026-08-17", "2026-08-24");
    for (const date of ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"]) {
      expect(msOn(slices, date) / H).toBeCloseTo(hoursOnDate(db, P, date), 6);
    }
    // …and the excluded rows really are excluded: Wednesday's 60-second bump
    // and Thursday's jiggler-covered four hours contribute nothing.
    expect(msOn(slices, "2026-08-19")).toBe(0);
    expect(msOn(slices, "2026-08-20")).toBe(0);
  });

  it("stays equal to the union across nesting, touching and disjoint intervals", () => {
    // Every shape the sweep has to get right, on one day: a nested interval, a
    // partial overlap, two that touch exactly, and a gap.
    const db = openTestDb();
    seed(db, [
      { id: "1", machineId: "a", start: "2026-08-17T08:00:00Z", end: "2026-08-17T12:00:00Z" },
      { id: "2", machineId: "b", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "3", machineId: "c", start: "2026-08-17T11:00:00Z", end: "2026-08-17T13:00:00Z" },
      { id: "4", machineId: "b", start: "2026-08-17T13:00:00Z", end: "2026-08-17T14:00:00Z" },
      { id: "5", machineId: "a", start: "2026-08-17T16:00:00Z", end: "2026-08-17T17:00:00Z" },
    ]);
    const slices = machineDaySlices(db, P, "2026-08-17", "2026-08-18");

    // 08:00–14:00 is one island (6 h), 16:00–17:00 another (1 h). 7 h.
    expect(hoursOnDate(db, P, "2026-08-17")).toBe(7);
    expect(msOn(slices, "2026-08-17")).toBe(7 * H);
    expect(slices).toEqual([
      // a: 08:00–12:00 and 16:00–17:00 = 5 h. b's nested hour is credited zero
      // and its 13:00–14:00 hour in full; c gets 12:00–13:00.
      { localDate: "2026-08-17", machineId: "a", ms: 5 * H },
      { localDate: "2026-08-17", machineId: "b", ms: 1 * H },
      { localDate: "2026-08-17", machineId: "c", ms: 1 * H },
    ]);
  });

  it("counts the idle-timeout grace exactly the way the union does", () => {
    // `grace_s` extends an interval's end inside `v_countable`, so a policy
    // that turns it on must move the split and the union together — or the
    // stack stops matching the bar the moment the knob is touched.
    const db = openTestDb();
    seed(db, [
      { id: "g", machineId: "a", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    const graced: Policy = { ...P, graceS: 900 };
    expect(hoursOnDate(db, graced, "2026-08-17")).toBe(1.25);
    expect(msOn(machineDaySlices(db, graced, "2026-08-17", "2026-08-18"), "2026-08-17")).toBe(
      1.25 * H,
    );
  });

  it("is bounded by the dates it was asked for", () => {
    const db = openTestDb();
    seedWeek(db);
    const monOnly = machineDaySlices(db, P, "2026-08-17", "2026-08-18");
    expect(new Set(monOnly.map((s) => s.localDate))).toEqual(new Set(["2026-08-17"]));
    expect(machineDaySlices(db, P, "2026-09-01", "2026-09-08")).toEqual([]);
  });
});
