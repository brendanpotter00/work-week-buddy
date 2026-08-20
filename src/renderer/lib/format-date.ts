/**
 * Display formatting for the `LocalDate` strings the wire carries.
 *
 * `design/mockup-notion-warm-*.png` shows "Mar 4, 2026" and "since Aug 2025",
 * not the raw 'YYYY-MM-DD'. The mockup is the acceptance target, so the
 * prettifying happens here — display only, on a string main already resolved.
 * No arithmetic on dates lives in the renderer.
 *
 * NEVER `new Date("2026-03-04")`: a bare date string is parsed as UTC, so in
 * any negative-offset zone it renders as March 3rd. `design/mock-data.reference.ts:28`
 * has exactly that bug and it does not travel here. The parts are split by hand
 * and fed to the LOCAL `Date` constructor, which cannot shift.
 */
import type { LocalDate } from "@/shared/ipc-types";

function toLocalDate(d: LocalDate): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** '2026-03-04' → 'Mar 4, 2026'. Returns the input unchanged if it is not a date. */
export function formatLocalDate(d: LocalDate | null): string | null {
  if (d === null) return null;
  const date = toLocalDate(d);
  if (date === null) return d;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** '2025-08-18' → 'Aug 2025'. The heatmap's "tracked since" line. */
export function formatMonthYear(d: LocalDate | null): string | null {
  if (d === null) return null;
  const date = toLocalDate(d);
  if (date === null) return d;
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
