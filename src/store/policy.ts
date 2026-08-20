/**
 * Policy — every product decision that the metrics depend on, in one object.
 *
 * `docs/DATA_MODEL.md` writes the policy knobs as bind parameters inside
 * `v_countable` (`:min_interval_s`, `:count_jiggler_time`, `:grace_s`). SQLite
 * refuses that outright — `CREATE VIEW … WHERE a >= :min` fails with
 * "parameters are not allowed in views" — so the views are created with the
 * defaults baked in as literals, and `queries.ts` re-inlines the *same* SQL as
 * CTEs when a caller passes a non-default policy. `docs/IMPL_TASKS_EXPANDED.md`
 * §T3.1 calls for exactly this: "create the views with the defaults baked as
 * literals and expose queries.ts variants that inline the parameters through a
 * whitelisted numeric formatter. The policy still lives in one place."
 *
 * The one place is here. The SQL text below is the only definition of
 * `v_countable` and `v_merged_day` in the codebase; `db.ts` bakes it into views
 * and `queries.ts` inlines it into CTEs. If a product decision starts leaking
 * into TypeScript, put it back in this file.
 */
import { DEFAULTS } from "../shared/constants";

export interface Policy {
  /** Seconds credited to an interval that ended on the idle timeout. */
  readonly graceS: number;
  /** Stray-bump floor. Intervals shorter than this do not count. */
  readonly minIntervalS: number;
  /** PRD D1. Default (a): time with our jiggler running does not count. */
  readonly countJigglerTime: boolean;
  /** 1 = Monday. Used by the week-boundary maths in `dates.ts`. */
  readonly weekStart: 0 | 1;
  /** Hours per heatmap level step. */
  readonly levelStepH: number;
}

export const DEFAULT_POLICY: Policy = {
  graceS: 0,
  minIntervalS: DEFAULTS.minIntervalMs / 1000,
  countJigglerTime: DEFAULTS.countJigglerTime,
  weekStart: DEFAULTS.weekStart,
  levelStepH: 2,
};

/**
 * The whitelist. A policy value becomes SQL text, so it is the one place a
 * string could reach the parser. Only finite numbers get through, and they are
 * re-parsed to prove the rendering round-trips.
 */
export function num(v: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`policy value is not a finite number: ${String(v)}`);
  }
  const s = String(v);
  if (Number(s) !== v) throw new Error(`policy value does not round-trip: ${String(v)}`);
  return s;
}

/**
 * `v_countable` — the policy layer. Verbatim from `docs/DATA_MODEL.md` with the
 * three bind parameters rendered as literals, because SQLite cannot bind into a
 * view.
 */
export function countableSql(p: Policy): string {
  return `SELECT *,
       CASE WHEN end_reason = 'idle_timeout' THEN ${num(p.graceS)} ELSE 0 END AS grace_s
FROM work_interval
WHERE duration_s >= ${num(p.minIntervalS)}
  AND (${p.countJigglerTime ? 1 : 0} = 1 OR jiggler_s = 0)`;
}

/**
 * `v_merged_day` — merge overlapping intervals ACROSS machines, per local day.
 * Verbatim from `docs/DATA_MODEL.md`. The
 * `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` frame is load-bearing:
 * it is what makes a nested interval fold into the island that contains it
 * instead of starting a new one.
 */
export const MERGED_DAY_SQL = `WITH o AS (
  SELECT local_date, started_at_ms, ended_at_ms + grace_s*1000 AS ended_at_ms,
         MAX(ended_at_ms + grace_s*1000) OVER (
           PARTITION BY local_date ORDER BY started_at_ms
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
  FROM v_countable
), m AS (
  SELECT *, CASE WHEN prev_max IS NULL OR started_at_ms > prev_max THEN 1 ELSE 0 END AS is_start FROM o
), g AS (
  SELECT *, SUM(is_start) OVER (PARTITION BY local_date ORDER BY started_at_ms
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS island FROM m
)
SELECT local_date, island, MIN(started_at_ms) AS s_ms, MAX(ended_at_ms) AS e_ms
FROM g GROUP BY local_date, island`;

/**
 * The `WITH` prefix that shadows both views with the caller's policy. A CTE
 * name takes precedence over a view of the same name for the statement it is
 * attached to, so every query below reads the same SQL whether it runs against
 * the baked views or an ad-hoc policy.
 */
export function policyCte(p: Policy): string {
  return `WITH v_countable AS (${countableSql(p)}),
     v_merged_day AS (${MERGED_DAY_SQL})`;
}
