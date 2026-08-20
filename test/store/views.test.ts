/**
 * The union merge, and the policy layer that feeds it.
 *
 * Overlapping intervals across the two Macs are correct and expected — typing
 * on the work Mac while a meeting runs on the personal Mac. Summing them
 * double-counts: 2 hours of rows for 1.5 hours of day.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../../src/store/policy";
import { countIntervals } from "../../src/store/intervals";
import { heatmap, hoursThisWeek, mergedDay, unionVsSum } from "../../src/store/queries";
import { openTestDb, seed, seedWeek, t, NOW_IN_WEEK } from "../fakes/seed-db";

const P = DEFAULT_POLICY;
const HOUR = 3_600_000;

describe("v_merged_day", () => {
  it("unions two overlapping machines into one island: 1.5 h, not 2", () => {
    const db = openTestDb();
    seed(db, [
      { id: "p", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "w", machineId: "work", start: "2026-08-17T09:30:00Z", end: "2026-08-17T10:30:00Z" },
    ]);
    const islands = mergedDay(db, P, "2026-08-17");
    expect(islands).toHaveLength(1);
    expect(islands[0]!.eMs - islands[0]!.sMs).toBe(1.5 * HOUR);
    expect(unionVsSum(db, P, "2026-08-17")).toEqual({ naiveSumH: 2, unionH: 1.5 });
  });

  it("folds a nested interval into the island that contains it: 2 h", () => {
    const db = openTestDb();
    seed(db, [
      { id: "p", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T11:00:00Z" },
      { id: "w", machineId: "work", start: "2026-08-17T09:30:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    const islands = mergedDay(db, P, "2026-08-17");
    expect(islands).toHaveLength(1);
    expect(islands[0]!.eMs - islands[0]!.sMs).toBe(2 * HOUR);
    expect(unionVsSum(db, P, "2026-08-17")).toEqual({ naiveSumH: 2.5, unionH: 2 });
  });

  it("joins exactly adjacent intervals into one island: 2 h", () => {
    const db = openTestDb();
    seed(db, [
      { id: "p", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "w", machineId: "work", start: "2026-08-17T10:00:00Z", end: "2026-08-17T11:00:00Z" },
    ]);
    const islands = mergedDay(db, P, "2026-08-17");
    expect(islands).toHaveLength(1);
    expect(islands[0]!.eMs - islands[0]!.sMs).toBe(2 * HOUR);
  });

  it("does not restart the island after a short interval nested in a long one", () => {
    const db = openTestDb();
    // THE case the `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` frame
    // exists for. Ordered by start, the row before `c` is the short `b`, whose
    // end is 10:00. Only the running maximum over ALL earlier rows knows that
    // `a` is still running until 12:00 — comparing against the immediately
    // preceding row alone would split the island here and count 10:30–11:00
    // twice.
    seed(db, [
      { id: "a", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T12:00:00Z" },
      { id: "b", machineId: "work", start: "2026-08-17T09:30:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "c", machineId: "work", start: "2026-08-17T10:30:00Z", end: "2026-08-17T11:00:00Z" },
    ]);
    const islands = mergedDay(db, P, "2026-08-17");
    expect(islands).toHaveLength(1);
    expect(islands[0]!.eMs - islands[0]!.sMs).toBe(3 * HOUR);
    expect(unionVsSum(db, P, "2026-08-17")).toEqual({ naiveSumH: 4, unionH: 3 });
  });

  it("is the 10 % error case from docs/DATA_MODEL.md: three intervals, one 30-minute overlap", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T13:00:00Z" },
      { id: "b", machineId: "work", start: "2026-08-17T12:30:00Z", end: "2026-08-17T13:30:00Z" },
      { id: "c", machineId: "personal", start: "2026-08-17T14:00:00Z", end: "2026-08-17T14:30:00Z" },
    ]);
    const { naiveSumH, unionH } = unionVsSum(db, P, "2026-08-17");
    expect({ naiveSumH, unionH }).toEqual({ naiveSumH: 5.5, unionH: 5 });
    expect((naiveSumH - unionH) / unionH).toBeCloseTo(0.1, 10);
    expect(mergedDay(db, P, "2026-08-17").map((i) => i.eMs - i.sMs)).toEqual([4.5 * HOUR, 0.5 * HOUR]);
  });

  it("leaves a gap as two islands", () => {
    const db = openTestDb();
    seed(db, [
      { id: "p", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "w", machineId: "work", start: "2026-08-17T14:00:00Z", end: "2026-08-17T15:00:00Z" },
    ]);
    const islands = mergedDay(db, P, "2026-08-17");
    expect(islands).toHaveLength(2);
    expect(islands.map((i) => i.eMs - i.sMs)).toEqual([HOUR, HOUR]);
    expect(unionVsSum(db, P, "2026-08-17")).toEqual({ naiveSumH: 2, unionH: 2 });
  });

  it("attributes a session crossing local midnight wholly to the start day", () => {
    const db = openTestDb();
    seed(db, [
      // 23:30 Sunday → 00:30 Monday. local_date is minted from started_at.
      { id: "night", machineId: "personal", start: "2026-08-23T23:30:00Z", end: "2026-08-24T00:30:00Z" },
      { id: "mon", machineId: "personal", start: "2026-08-24T09:00:00Z", end: "2026-08-24T10:00:00Z" },
    ]);
    const sunday = mergedDay(db, P, "2026-08-23");
    expect(sunday).toHaveLength(1);
    expect(sunday[0]!.eMs).toBe(t("2026-08-24T00:30:00Z"));
    expect(sunday[0]!.eMs - sunday[0]!.sMs).toBe(HOUR);

    // The hour after midnight belongs to Sunday, and Monday keeps only its own.
    const monday = mergedDay(db, P, "2026-08-24");
    expect(monday).toHaveLength(1);
    expect(monday[0]!.sMs).toBe(t("2026-08-24T09:00:00Z"));

    const days = heatmap(db, P, "UTC", t("2026-08-24T20:00:00Z"));
    expect(days).toEqual([
      { date: "2026-08-23", count: 1, level: 0 },
      { date: "2026-08-24", count: 1, level: 0 },
    ]);
  });

  it("does not merge two machines' intervals across a local-date boundary", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "personal", start: "2026-08-23T23:30:00Z", end: "2026-08-24T00:30:00Z" },
      // Same wall-clock overlap, but the work Mac started after midnight, so it
      // is a different local_date and a different partition.
      { id: "b", machineId: "work", start: "2026-08-24T00:00:00Z", end: "2026-08-24T01:00:00Z" },
    ]);
    expect(mergedDay(db, P, "2026-08-23")).toHaveLength(1);
    expect(mergedDay(db, P, "2026-08-24")).toHaveLength(1);
  });
});

describe("v_countable — the policy layer", () => {
  it("excludes intervals under the stray-bump floor without deleting them", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(countIntervals(db)).toBe(5);
    expect(hoursThisWeek(db, P, "UTC", NOW_IN_WEEK)).toBe(2.5);

    // Lower the floor and the 60-second row appears. Same five rows.
    const lower: Policy = { ...P, minIntervalS: 30 };
    expect(hoursThisWeek(db, lower, "UTC", NOW_IN_WEEK)).toBe(2.52);
    expect(countIntervals(db)).toBe(5);
  });

  it("excludes jiggler-covered intervals under PRD D1 (a), also without deleting them", () => {
    const db = openTestDb();
    seedWeek(db);
    expect(hoursThisWeek(db, P, "UTC", NOW_IN_WEEK)).toBe(2.5);

    const counted: Policy = { ...P, countJigglerTime: true };
    expect(hoursThisWeek(db, counted, "UTC", NOW_IN_WEEK)).toBe(6.5);
    expect(countIntervals(db)).toBe(5);
  });

  it("credits the grace window through the merge when policy asks for it", () => {
    const db = openTestDb();
    seedWeek(db);
    const graced: Policy = { ...P, graceS: 60 };
    // Monday's island stretches to 10:31 and Tuesday's to 14:01.
    expect(hoursThisWeek(db, graced, "UTC", NOW_IN_WEEK)).toBe(2.53);
  });

  it("credits grace only to intervals that ended on the idle timeout", () => {
    const db = openTestDb();
    seed(db, [
      { id: "idle", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      {
        id: "quit",
        machineId: "personal",
        start: "2026-08-17T14:00:00Z",
        end: "2026-08-17T15:00:00Z",
        endReason: "app_quit",
      },
    ]);
    const graced: Policy = { ...P, graceS: 600 };
    const islands = mergedDay(db, graced, "2026-08-17");
    expect(islands.map((i) => i.eMs - i.sMs)).toEqual([HOUR + 600_000, HOUR]);
  });
});
