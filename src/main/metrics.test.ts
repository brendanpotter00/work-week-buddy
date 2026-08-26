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

import { buildMetrics } from "./metrics";
import { DEFAULT_POLICY } from "../store";
import { DEFAULT_METRICS_POLICY } from "../shared/ipc-types";
import { openTestDb, seed, seedWeek, t, NOW_IN_WEEK } from "../../test/fakes/seed-db";

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
