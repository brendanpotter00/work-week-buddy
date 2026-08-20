/**
 * The six metric queries from `docs/DATA_MODEL.md`, each behind a typed
 * function, plus the honesty widget.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Policy lives in `v_countable` and nowhere else.** The SQL text of both
 *    views is defined once, in `policy.ts`, and inlined here as CTEs that
 *    shadow the baked views. No product decision is re-implemented in
 *    TypeScript.
 *
 * 2. **Week boundaries are computed in TypeScript** from the display timezone
 *    and bound as parameters. `date('now','localtime')` is DST-naive and
 *    silently wrong when travelling, so it appears nowhere below.
 */
import type { DatabaseSync } from "node:sqlite";
import { n, nOrZero, s, type Row } from "./coerce";
import { addDays, localDateOf, weekBounds } from "./dates";
import { num, policyCte, type Policy } from "./policy";

/** The heatmap window: a full year plus the partial week. */
export const HEATMAP_DAYS = 371;

/** 1) HOURS THIS WEEK — the headline. Union across machines, so a day cannot
 *  contain more than 24 hours of "was working". */
export function hoursThisWeek(
  db: DatabaseSync,
  p: Policy,
  tz: string,
  nowMs = Date.now(),
): number {
  const wk = weekBounds(nowMs, tz, p.weekStart);
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours_this_week
       FROM v_merged_day
       WHERE local_date >= ? AND local_date < ?`,
    )
    .get(wk.from, wk.toExclusive);
  return nOrZero(row as Row | undefined, "hours_this_week");
}

export interface AvgInterval {
  readonly minutes: number;
  readonly n: number;
}

/** 2) AVERAGE INTERVAL LENGTH — over raw intervals, NOT merged islands. The
 *  interval is the unit; merging would blend two machines into one "interval". */
export function avgIntervalThisWeek(
  db: DatabaseSync,
  p: Policy,
  tz: string,
  nowMs = Date.now(),
): AvgInterval {
  const wk = weekBounds(nowMs, tz, p.weekStart);
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT ROUND(AVG(duration_s + grace_s) / 60.0, 1) AS avg_interval_min,
              COUNT(*)                                   AS n_intervals
       FROM v_countable
       WHERE local_date >= ? AND local_date < ?`,
    )
    .get(wk.from, wk.toExclusive) as Row | undefined;
  return { minutes: nOrZero(row, "avg_interval_min"), n: nOrZero(row, "n_intervals") };
}

export function avgIntervalAllTime(db: DatabaseSync, p: Policy): AvgInterval {
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT ROUND(AVG(duration_s + grace_s) / 60.0, 1) AS avg_interval_min,
              COUNT(*)                                   AS n_intervals
       FROM v_countable`,
    )
    .get() as Row | undefined;
  return { minutes: nOrZero(row, "avg_interval_min"), n: nOrZero(row, "n_intervals") };
}

export interface Longest {
  /** Which question won: one machine's own interval, or a merged session. */
  readonly kind: "single_interval" | "merged_session";
  readonly hours: number;
  readonly localDate: string;
  /** NULL for a merged session — by definition it spans machines. */
  readonly machineId: string | null;
}

/** 3) LONGEST INTERVAL — two ways, because they answer different questions.
 *  `null` when nothing is countable yet. */
export function longestInterval(db: DatabaseSync, p: Policy): Longest | null {
  const raw = db
    .prepare(
      `${policyCte(p)}
       SELECT 'single_interval' AS kind, machine_id, local_date,
              ROUND(MAX(duration_s + grace_s)/3600.0, 2) AS hours
       FROM v_countable
       UNION ALL
       SELECT 'merged_session', NULL, local_date, ROUND(MAX(e_ms - s_ms)/3600000.0, 2)
       -- kind DESC is a tiebreak docs/DATA_MODEL.md does not have. A merged
       -- island always contains at least one whole interval, so the two
       -- branches tie whenever nothing actually merged -- and without a
       -- tiebreak, which of them SQLite returns is arbitrary. On a tie the
       -- single interval wins, because it can name the machine.
       FROM v_merged_day GROUP BY local_date ORDER BY hours DESC, kind DESC LIMIT 1`,
    )
    .get() as Row | undefined;
  if (raw === undefined || raw["hours"] === null) return null;
  const kind = s(raw, "kind");
  return {
    kind: kind === "merged_session" ? "merged_session" : "single_interval",
    hours: n(raw, "hours"),
    localDate: s(raw, "local_date"),
    machineId: raw["machine_id"] === null ? null : s(raw, "machine_id"),
  };
}

export interface HeatmapDay {
  readonly date: string;
  readonly count: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

/** 4) PER-DAY HEATMAP. `react-activity-calendar` wants {date, count, level}. */
export function heatmap(
  db: DatabaseSync,
  p: Policy,
  tz: string,
  nowMs = Date.now(),
): HeatmapDay[] {
  const from = addDays(localDateOf(nowMs, tz), -HEATMAP_DAYS);
  const rows = db
    .prepare(
      `${policyCte(p)}
       SELECT local_date AS date,
              ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS count,
              MIN(4, CAST(SUM(e_ms - s_ms) / 3600000.0 / NULLIF(${num(p.levelStepH)}, 0) AS INTEGER)) AS level
       FROM v_merged_day
       WHERE local_date >= ?
       GROUP BY local_date ORDER BY local_date`,
    )
    .all(from);
  return rows.map((raw) => {
    const row = raw as Row;
    const lvl = Math.max(0, Math.min(4, Math.trunc(nOrZero(row, "level"))));
    return {
      date: s(row, "date"),
      count: nOrZero(row, "count"),
      level: lvl as 0 | 1 | 2 | 3 | 4,
    };
  });
}

export interface MachineHours {
  readonly machineId: string;
  readonly label: string;
  readonly hours: number;
  readonly intervals: number;
  readonly meetingHours: number;
  readonly jigglerHours: number;
}

/** 5) PER-MACHINE BREAKDOWN. A plain SUM is correct here: one machine's own
 *  intervals are disjoint by construction, so there is nothing to merge. */
export function byMachine(
  db: DatabaseSync,
  p: Policy,
  tz: string,
  nowMs = Date.now(),
): MachineHours[] {
  const wk = weekBounds(nowMs, tz, p.weekStart);
  const rows = db
    .prepare(
      // LEFT JOIN, not JOIN. `docs/DATA_MODEL.md` writes an inner join, but the
      // machine table is populated by heartbeats pulled from the cloud — so an
      // inner join makes a machine's hours vanish from the breakdown until its
      // heartbeat arrives, silently and with no error. The label falls back to
      // the machine id.
      `${policyCte(p)}
       SELECT i.machine_id                              AS machine_id,
              COALESCE(m.label, i.machine_id)           AS label,
              ROUND(SUM(i.duration_s + i.grace_s)/3600.0, 2) AS hours,
              COUNT(*)                                  AS intervals,
              ROUND(SUM(i.camera_s)/3600.0, 2)          AS meeting_hours,
              ROUND(SUM(i.jiggler_s)/3600.0, 2)         AS hours_with_jiggler_on
       FROM v_countable i LEFT JOIN machine m ON m.machine_id = i.machine_id
       WHERE i.local_date >= ? AND i.local_date < ?
       GROUP BY i.machine_id ORDER BY hours DESC`,
    )
    .all(wk.from, wk.toExclusive);
  return rows.map((raw) => {
    const row = raw as Row;
    return {
      machineId: s(row, "machine_id"),
      label: s(row, "label"),
      hours: nOrZero(row, "hours"),
      intervals: nOrZero(row, "intervals"),
      meetingHours: nOrZero(row, "meeting_hours"),
      jigglerHours: nOrZero(row, "hours_with_jiggler_on"),
    };
  });
}

export interface UnionVsSum {
  readonly naiveSumH: number;
  readonly unionH: number;
}

/** 6) The honesty widget: what the union actually saves. Show both, so overlap
 *  between the two Macs is visible rather than hidden. */
export function unionVsSum(
  db: DatabaseSync,
  p: Policy,
  localDate: string,
): UnionVsSum {
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT (SELECT SUM(duration_s + grace_s)/3600.0 FROM v_countable  WHERE local_date = ?) AS naive_sum_h,
              (SELECT SUM(e_ms - s_ms)/3600000.0       FROM v_merged_day WHERE local_date = ?) AS union_h`,
    )
    .get(localDate, localDate) as Row | undefined;
  return { naiveSumH: nOrZero(row, "naive_sum_h"), unionH: nOrZero(row, "union_h") };
}

/** Merged islands for one local day. The union merge, straight out. */
export function mergedDay(
  db: DatabaseSync,
  p: Policy,
  localDate: string,
): Array<{ island: number; sMs: number; eMs: number }> {
  const rows = db
    .prepare(
      `${policyCte(p)}
       SELECT island, s_ms, e_ms FROM v_merged_day WHERE local_date = ? ORDER BY s_ms`,
    )
    .all(localDate);
  return rows.map((raw) => {
    const row = raw as Row;
    return { island: n(row, "island"), sMs: n(row, "s_ms"), eMs: n(row, "e_ms") };
  });
}
