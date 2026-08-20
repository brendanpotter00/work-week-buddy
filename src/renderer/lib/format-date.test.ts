import { describe, expect, it } from "vitest";

import { formatLocalDate, formatMonthYear } from "./format-date";

describe("formatLocalDate", () => {
  it("keeps the day the wire sent, in every zone", () => {
    // The trap: `new Date("2026-03-04")` is parsed as UTC, so anywhere west of
    // Greenwich it renders March 3rd. Every date on the wire is already local
    // to the row that produced it; re-interpreting it as UTC moves it.
    // design/mock-data.reference.ts:28 has exactly this bug.
    expect(formatLocalDate("2026-03-04")).toBe("Mar 4, 2026");
    expect(formatLocalDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatLocalDate("2025-12-31")).toBe("Dec 31, 2025");
  });

  it("passes null through, because null is 'no data' and renders as an em-dash", () => {
    expect(formatLocalDate(null)).toBeNull();
    expect(formatMonthYear(null)).toBeNull();
  });

  it("returns anything that is not a date unchanged rather than 'Invalid Date'", () => {
    expect(formatLocalDate("")).toBe("");
    expect(formatLocalDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatMonthYear", () => {
  it("renders the heatmap's 'tracked since' line the way the mockup does", () => {
    expect(formatMonthYear("2025-08-18")).toBe("Aug 2025");
    expect(formatMonthYear("2026-01-31")).toBe("Jan 2026");
  });
});
