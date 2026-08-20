/**
 * Pure formatters and calendar arithmetic — `docs/IMPL_UI.md` §3.3.
 *
 * Used by the tray (main) AND the dashboard (renderer). That is the point: one
 * implementation, so the menu bar and the window cannot disagree about the
 * current interval. No imports beyond types; no clock read that is not passed
 * in as a parameter.
 */
import type { LiveStatus, MetricsPolicy } from "./ipc-types";

// ── calendar arithmetic (local, never UTC) ──────────────────────────────────

/**
 * 'YYYY-MM-DD' in the LOCAL zone.
 *
 * NEVER `new Date(ms).toISOString().slice(0,10)` — that is UTC and silently
 * moves every evening interval to the next day.
 * `design/mock-data.reference.ts:28` does exactly this; it is not carried here.
 */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 local. PRD §7: a work week's week starts on Monday. */
export function startOfIsoWeek(ms: number): number {
  const d = new Date(startOfLocalDay(ms));
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  // Re-normalise: setDate can cross a DST edge and leave 23:00 or 01:00 behind.
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function nextIsoWeekStart(ms: number): number {
  const d = new Date(startOfIsoWeek(ms));
  d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ISO-8601 week number, for the "week 34" line in the dashboard header. */
export function isoWeekNumber(ms: number): number {
  const d = new Date(startOfLocalDay(ms));
  // Move to the Thursday of this ISO week: the year that Thursday falls in is
  // the ISO week-year, which is the whole reason the algorithm looks like this.
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
}

// ── the one duration rule ───────────────────────────────────────────────────

/**
 * Credited length of the OPEN interval, in ms.
 *
 * THE RULE (AGENTS.md, PRD §3.2): an interval is worth time up to its last real
 * signal — never up to `now()`. The only exception is a camera/mic level
 * holding it open, where the eventual close stamp will be `now`, capped.
 *
 * This is the single function the tray title and the dashboard status strip
 * both call.
 */
export function creditedOpenMs(
  s: Pick<LiveStatus, "openedAtMs" | "lastSignalMs" | "heldOpenBy" | "heldUntilMs">,
  nowMs: number,
): number {
  if (s.openedAtMs === null) return 0;
  const end =
    s.heldOpenBy === null
      ? (s.lastSignalMs ?? s.openedAtMs)
      : Math.min(nowMs, s.heldUntilMs ?? nowMs);
  return Math.max(0, end - s.openedAtMs);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Hours this week for the tray title and the "This week" stat card.
 *
 * The open interval is credited to `lastSignalMs`, not to `now`: crediting to
 * `now` makes the headline number SHRINK by up to fifteen minutes the moment
 * the interval closes, and a number that goes down is a support ticket.
 *
 * The same `v_countable` filters are applied to the row that does not exist
 * yet, so the tray shows exactly what the close rule will write.
 */
export function hoursThisWeek(
  status: LiveStatus,
  policy: Pick<MetricsPolicy, "countJigglerTime" | "minIntervalS">,
  nowMs: number,
): number | null {
  const closed = status.closedHoursThisWeek;
  const openMs = creditedOpenMs(status, nowMs);
  const openCounts =
    status.state === "working" &&
    openMs >= policy.minIntervalS * 1000 &&
    (policy.countJigglerTime === 1 || !status.jigglerOnForOpenInterval);
  const openH = openCounts ? openMs / 3_600_000 : 0;
  if (closed === null) return openCounts ? round1(openH) : null;
  return round1(closed + openH);
}

// ── display formatters ──────────────────────────────────────────────────────

/** '36.5h' · '—h' when there is no data at all (never for a true zero). */
export function formatTrayTitle(hours: number | null, degraded: boolean): string {
  const n = hours === null ? "—" : hours.toFixed(1);
  return degraded ? `${n}h ⚠︎` : `${n}h`;
}

/** '2h 41m' · '41m' · '0m'. Interval lengths and averages. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** '12s' · '4m' · '2h'. The ONLY formatter allowed to be relative to now(). */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** '36.5' · '—'. null means no data; 0 means zero hours. They differ. */
export function formatHours(h: number | null, digits = 1): string {
  return h === null ? "—" : h.toFixed(digits);
}

export function formatCount(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

/** '+4.2h vs last week' · '−1.1h vs last week' · null when there is no baseline. */
export function formatWeekDelta(thisWeek: number | null, lastWeek: number | null): string | null {
  if (thisWeek === null || lastWeek === null) return null;
  const d = thisWeek - lastWeek;
  const sign = d >= 0 ? "+" : "−";
  return `${sign}${Math.abs(d).toFixed(1)}h vs last week`;
}

/** 'Wednesday, August 19 · week 34' — the dashboard subtitle. */
export function formatHeaderDate(ms: number): string {
  const d = new Date(ms);
  const long = d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return `${long} · week ${isoWeekNumber(ms)}`;
}
