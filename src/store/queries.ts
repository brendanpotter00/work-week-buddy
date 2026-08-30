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

/**
 * 1b) HOURS ON ONE LOCAL DAY — query 1 with a day's bounds instead of a week's.
 *
 * Deliberately the SAME `v_merged_day` union, not a `SUM(duration_s)`: a plain
 * sum double-counts the half-hour where the work Mac and the personal Mac were
 * both awake, and `docs/DATA_MODEL.md` measured that at 10% error on a single
 * three-interval day. A day cannot contain more than 24 hours of "was working",
 * however many Macs were on.
 *
 * The stray-bump floor and the jiggler exclusion arrive the only way they ever
 * do — through `policyCte()` — so "today" and "this week" cannot end up
 * disagreeing about which intervals count.
 */
export function hoursOnDate(db: DatabaseSync, p: Policy, localDate: string): number {
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours
       FROM v_merged_day
       WHERE local_date = ?`,
    )
    .get(localDate);
  return nOrZero(row as Row | undefined, "hours");
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
       -- machine_id is a TIEBREAK docs/DATA_MODEL.md does not have. Two Macs
       -- on the same hours is not exotic, and without it SQLite's order is
       -- arbitrary — which used to be invisible, and stopped being so the
       -- moment this order started choosing the bar chart's shades. A legend
       -- that swaps its greys between two renders of the same week is worse
       -- than no legend.
       GROUP BY i.machine_id ORDER BY hours DESC, i.machine_id`,
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

export interface MachineDaySlice {
  readonly localDate: string;
  readonly machineId: string;
  /** Milliseconds of that day's UNION credited to this machine. Never a sum. */
  readonly ms: number;
}

/**
 * 5b) PER-MACHINE, PER-DAY — the union SPLIT, which is not the same query as 5.
 *
 * Query 5 sums each machine's own intervals, and `docs/DATA_MODEL.md` is right
 * that a plain SUM is correct for that question: one machine's intervals are
 * disjoint, so nothing needs merging. But the totals it produces are the NAIVE
 * SUM — add them up and you get the honesty widget's `naive_sum_h`, which is
 * larger than the day's union whenever two Macs were awake at once.
 *
 * A stacked bar cannot use those numbers. Its segments have to come to the
 * bar's own height, and the bar is the union.
 *
 * So this splits the union instead of summing the intervals, by the one rule
 * that is both deterministic and explicable: **a moment belongs to whichever
 * Mac was already working**. Walking the day's intervals in start order, an
 * interval is credited only with the part of itself that reaches past
 * everything before it — `e - MAX(s, prev_max)`, floored at zero, where
 * `prev_max` is the furthest any earlier interval reached. That is the same
 * sweep `v_merged_day` performs, with the same window frame; it just keeps the
 * per-row contributions rather than collapsing them into islands. Summing them
 * back up therefore lands on exactly the union, per day, by construction.
 *
 * The visible consequence, and it is intended: an interval that ran entirely
 * inside another Mac's is credited zero here, while query 5 still shows its
 * hours. The two answer different questions and the dashboard says so.
 *
 * `ORDER BY started_at_ms, machine_id, id` — the tiebreak does not change the
 * total (any start-ordered sweep gives the union) but it does decide who gets
 * an exactly-simultaneous minute, and that must not vary between runs.
 */
export function machineDaySlices(
  db: DatabaseSync,
  p: Policy,
  fromDate: string,
  toExclusive: string,
): MachineDaySlice[] {
  const rows = db
    .prepare(
      `${policyCte(p)},
       o AS (
         SELECT machine_id, local_date,
                started_at_ms                     AS s_ms,
                ended_at_ms + grace_s*1000        AS e_ms,
                MAX(ended_at_ms + grace_s*1000) OVER (
                  PARTITION BY local_date ORDER BY started_at_ms, machine_id, id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
         FROM v_countable
         WHERE local_date >= ? AND local_date < ?
       )
       SELECT local_date, machine_id,
              SUM(MAX(0, e_ms - MAX(s_ms, COALESCE(prev_max, s_ms)))) AS ms
       FROM o
       GROUP BY local_date, machine_id
       ORDER BY local_date, machine_id`,
    )
    .all(fromDate, toExclusive);
  return rows.map((raw) => {
    const row = raw as Row;
    return {
      localDate: s(row, "local_date"),
      machineId: s(row, "machine_id"),
      ms: nOrZero(row, "ms"),
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
