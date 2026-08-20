/**
 * Civil-date maths. These are the tests that stand in for `date('now',
 * 'localtime')`, which is DST-naive and wrong when travelling.
 */
import { describe, it, expect } from "vitest";
import { addDays, dayOfWeek, localDateOf, startOfWeek, weekBounds } from "../../src/store/dates";
import { t } from "../fakes/seed-db";

describe("localDateOf", () => {
  it("uses the zone the interval happened in, not the host's", () => {
    const ms = t("2026-08-19T02:00:00Z");
    expect(localDateOf(ms, "UTC")).toBe("2026-08-19");
    expect(localDateOf(ms, "America/Chicago")).toBe("2026-08-18"); // 21:00 the day before
    expect(localDateOf(ms, "Asia/Tokyo")).toBe("2026-08-19"); // 11:00 the same day
  });

  it("lands on the right side of a DST transition", () => {
    // US spring-forward is 2026-03-08 at 02:00 local.
    expect(localDateOf(t("2026-03-08T05:30:00Z"), "America/Chicago")).toBe("2026-03-07");
    expect(localDateOf(t("2026-03-08T08:30:00Z"), "America/Chicago")).toBe("2026-03-08");
  });

  it("throws on an unknown zone rather than guessing", () => {
    expect(() => localDateOf(0, "Mars/Olympus_Mons")).toThrow();
  });
});

describe("civil-date arithmetic", () => {
  it("crosses months and years", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("crosses a DST boundary without losing or gaining a day", () => {
    // 23 hours long in Chicago. Millisecond arithmetic would land on the 7th.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("knows the weekday of a civil date", () => {
    expect(dayOfWeek("2026-08-17")).toBe(1);
    expect(dayOfWeek("2026-08-23")).toBe(0);
  });

  it("rejects anything that is not a YYYY-MM-DD date", () => {
    expect(() => addDays("2026-8-1", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addDays("", 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe("weekBounds", () => {
  it("returns a Monday and the Monday after it", () => {
    const wk = weekBounds(t("2026-08-19T12:00:00Z"), "UTC", 1);
    expect(wk).toEqual({ from: "2026-08-17", toExclusive: "2026-08-24" });
    expect(dayOfWeek(wk.from)).toBe(1);
  });

  it("keeps Sunday in the week that started the Monday before it", () => {
    expect(weekBounds(t("2026-08-23T23:59:00Z"), "UTC", 1).from).toBe("2026-08-17");
    expect(weekBounds(t("2026-08-24T00:01:00Z"), "UTC", 1).from).toBe("2026-08-24");
  });

  it("follows the display timezone across the week boundary", () => {
    const sundayNight = t("2026-08-23T23:00:00Z");
    expect(weekBounds(sundayNight, "UTC", 1).from).toBe("2026-08-17");
    expect(weekBounds(sundayNight, "Asia/Tokyo", 1).from).toBe("2026-08-24");
  });

  it("spans exactly seven calendar days through a DST change", () => {
    // The week containing spring-forward is 167 hours long, not 168. Computing
    // it in milliseconds would end the week an hour early.
    const wk = weekBounds(t("2026-03-11T18:00:00Z"), "America/Chicago", 1);
    expect(wk).toEqual({ from: "2026-03-09", toExclusive: "2026-03-16" });
  });

  it("supports a Sunday week start", () => {
    expect(weekBounds(t("2026-08-19T12:00:00Z"), "UTC", 0)).toEqual({
      from: "2026-08-16",
      toExclusive: "2026-08-23",
    });
    expect(startOfWeek("2026-08-16", 0)).toBe("2026-08-16");
  });
});
