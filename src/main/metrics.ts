/**
 * The six `docs/DATA_MODEL.md` queries, assembled into one `MetricsBundle` so
 * the dashboard gets everything in a single round trip.
 *
 * This file composes `src/store/queries.ts`; it does not reimplement any of it.
 * The policy knobs still live in `v_countable` and nowhere else — the two extra
 * aggregates below are built on `policyCte()`, the same single definition of
 * the view that `db.ts` bakes and `queries.ts` inlines.
 *
 * `—` versus `0`: every metric is `number | null`, and `null` means "no
 * countable row exists", never "zero hours". `SUM()` over no rows is NULL in
 * SQLite, which is what makes that distinction free.
 */
import type { DatabaseSync } from "node:sqlite";

import { apportion } from "../core";
import {
  addDays,
  avgIntervalAllTime,
  avgIntervalThisWeek,
  byMachine,
  countIntervals,
  dayOfWeek,
  heatmap,
  hoursOnDate,
  hoursThisWeek,
  localDateOf,
  longestInterval,
  machineDaySlices,
  policyCte,
  unionVsSum,
  weekBounds,
  type Policy,
} from "../store";
import { nOrNull, sOrNull, type Row } from "../store/coerce";
import type {
  HeatmapDay,
  LocalDate,
  MetricsBundle,
  MetricsPolicy,
  WeekBar,
  WeekBarMachine,
  WeekPoint,
} from "../shared/ipc-types";

const DAY_NAMES: WeekBar["day"][] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * How many bars the strip under the heatmap draws.
 *
 * SIXTEEN, NOT FIFTY-THREE, AND THE NUMBER IS THE DESIGN. The strip is the
 * width of the heatmap's grid, which is fixed at 53 × 14 − 3 = 739 px however
 * wide the window is. Fifty-three weeks is therefore a 14 px pitch, and `44.1`
 * set at 11 px measures 24.31 px — the labels would overlap and the strip would
 * be a picture again, which is the one thing it is not for. Sixteen weeks gives
 * a 46.2 px pitch, so every bar can carry a printed value AND a date.
 *
 * The accepted cost, which the owner chose with the mockup in front of him: at
 * sixteen the bars no longer line up with the 53 columns above. Do not "fix"
 * that by going back to 53 — it costs the numbers, which are the feature.
 */
export const WEEK_SERIES_WEEKS = 16;

/**
 * `MetricsPolicy` (the wire) → `Policy` (the view).
 *
 * The committed `src/store/policy.ts` renders the heatmap level as
 * `floor(hours / levelStepH)`, while `docs/IMPL_UI.md` §5.8 wants three explicit
 * thresholds. The committed store wins for the SQL, and the thresholds are
 * applied on the way out in `applyThresholds()` — same numbers, no fork of the
 * view definition.
 */
export function toStorePolicy(p: MetricsPolicy, base: Policy): Policy {
  return {
    ...base,
    graceS: p.graceS,
    minIntervalS: p.minIntervalS,
    countJigglerTime: p.countJigglerTime === 1,
  };
}

/** `[2,5,8]` ⇒ 0 · <2 · <5 · <8 · ≥8. A 1.9-hour day must not look like a day off. */
export function applyThresholds(
  days: readonly HeatmapDay[],
  thresholds: readonly [number, number, number],
): HeatmapDay[] {
  const [t1, t2, t3] = thresholds;
  return days.map((d) => ({
    ...d,
    level: d.count <= 0 ? 0 : d.count < t1 ? 1 : d.count < t2 ? 2 : d.count < t3 ? 3 : 4,
  }));
}

interface AllTimeTotals {
  hoursTracked: number | null;
  sinceDate: LocalDate | null;
}

function allTimeTotals(db: DatabaseSync, p: Policy): AllTimeTotals {
  const row = db
    .prepare(
      `${policyCte(p)}
       SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours_tracked,
              MIN(local_date)                        AS since_date
       FROM v_merged_day`,
    )
    .get() as Row | undefined;
  if (row === undefined) return { hoursTracked: null, sinceDate: null };
  return { hoursTracked: nOrNull(row, "hours_tracked"), sinceDate: sOrNull(row, "since_date") };
}

interface MachineMeta {
  label: string | null;
  lastSeenMs: number | null;
}

function machineMeta(db: DatabaseSync): Map<string, MachineMeta> {
  const rows = db.prepare(`SELECT machine_id, label, last_seen_ms FROM machine`).all();
  const out = new Map<string, MachineMeta>();
  for (const raw of rows) {
    const row = raw as Row;
    const id = row["machine_id"];
    if (typeof id !== "string") continue;
    out.set(id, { label: sOrNull(row, "label"), lastSeenMs: nOrNull(row, "last_seen_ms") });
  }
  return out;
}

/**
 * The seven bars, each carrying its own per-machine split of the union.
 *
 * TWO SOURCES, ONE NUMBER, ON PURPOSE. `hours` stays the heatmap's figure for
 * that date — `ROUND(SUM(e_ms - s_ms)/3600000, 2)` over `v_merged_day` — which
 * is what the bar has always been and is the same union `hoursOnDate()` and the
 * "This week" card are built on. The split comes from `machineDaySlices()`,
 * which sweeps the same rows. The two agree because they measure the same
 * union in the same milliseconds, and `apportion()` then hands out exactly
 * `hours` so the stack cannot come to anything else even if they ever stopped
 * agreeing. `src/main/metrics.test.ts` pins the agreement itself against
 * `hoursOnDate()` rather than trusting the argument.
 *
 * The machine ORDER is `byMachine`'s, which is hours-descending — so the
 * dashboard's darkest shade lands on the Mac that did the most work, every
 * render, whichever day you look at.
 */
function buildWeekBars(
  db: DatabaseSync,
  p: Policy,
  weekFrom: LocalDate,
  machines: ReadonlyArray<{ machineId: string; label: string }>,
  hoursByDate: ReadonlyMap<string, number>,
): WeekBar[] {
  const slices = machineDaySlices(db, p, weekFrom, addDays(weekFrom, 7));

  const msByDate = new Map<string, Map<string, number>>();
  for (const sl of slices) {
    const day = msByDate.get(sl.localDate) ?? new Map<string, number>();
    day.set(sl.machineId, (day.get(sl.machineId) ?? 0) + sl.ms);
    msByDate.set(sl.localDate, day);
  }

  const known = new Set(machines.map((m) => m.machineId));
  const labels = new Map(machines.map((m) => [m.machineId, m.label]));

  return DAY_NAMES.map((day, i) => {
    const date = addDays(weekFrom, i);
    const hours = hoursByDate.get(date) ?? 0;
    const ms = msByDate.get(date) ?? new Map<string, number>();

    // `byMachine` and `machineDaySlices` read the same `v_countable` rows over
    // the same seven days, so an id here that is not there cannot happen. It is
    // appended rather than dropped anyway: a dropped id would be hours credited
    // to a machine the stack never draws, and that is a stack quietly shorter
    // than its bar — the one failure this whole path exists to rule out.
    const extra = [...ms.keys()].filter((id) => !known.has(id)).sort();
    const ids = [...machines.map((m) => m.machineId), ...extra];

    const parts = apportion(
      ids.map((id) => ms.get(id) ?? 0),
      Math.round(hours * 100),
    );
    const split: WeekBarMachine[] = ids.map((id, k) => ({
      machineId: id,
      label: labels.get(id) ?? id,
      hours: (parts[k] ?? 0) / 100,
    }));

    return { day, date, hours, machines: split };
  });
}

/**
 * The strip's sixteen weeks, OLDEST FIRST.
 *
 * ── ONE SOURCE FOR EVERY WEEKLY FIGURE ON THE PAGE ──────────────────────────
 * Each entry is a call to `hoursThisWeek()`: the same function, the same
 * `policyCte()`, the same `v_merged_day` union that fills `week.hours` and
 * `week.prevHours` two lines apart in `buildMetrics()`. Summing `heatmap`
 * instead is the tempting version and it is quietly wrong — `heatmap` rounds
 * each DAY to 2dp while `hoursThisWeek` rounds the WEEK'S SUM, so seven rounded
 * days land up to 0.035 h out. That is enough for the newest bar to print a
 * different tenth from the "This week" stat card four inches above it, and
 * nothing would report an error.
 *
 * ── THE ANCHOR IS DRAGGED TO MIDWEEK BEFORE THE WALK STARTS ─────────────────
 * `k * WEEK_MS` is seven 24-HOUR days, not seven calendar days. A DST
 * transition anywhere in the window slides every earlier anchor by an hour, and
 * an anchor sitting at 00:30 on a Monday slides into the week BEFORE it: one
 * week printed twice, another dropped, no error anywhere. Three days from
 * either boundary an hour cannot reach the edge, so the anchor is moved to
 * midweek first. It stays inside the CURRENT week, so `k = 0` still resolves to
 * exactly the bounds `week.hours` was measured over.
 *
 * ── `null` IS NOT `0` ───────────────────────────────────────────────────────
 * A week that ended before tracking began was never observed and gets `null`,
 * so the strip draws no bar; a zero-height bar would claim a week off nobody
 * measured. A week inside the tracked range with nothing countable in it gets
 * the `0` the query returns and IS drawn — that is a week off, and it is a
 * fact. The owner has two weeks of history, so the first case is most of this
 * list today.
 *
 * "Tracking began" is `allTime.sinceDate`, the same date the heatmap card
 * prints as "… h tracked since …" — so the strip starts where the card beside
 * it says it should. A database holding rows that are all sub-floor or all
 * jiggler has no such date but is not empty, and `week.hours` is `0` for it;
 * this week's own start stands in for those, so the newest bar and the "This
 * week" card cannot disagree in ANY state.
 */
function buildWeekSeries(
  db: DatabaseSync,
  p: Policy,
  tz: string,
  nowMs: number,
  empty: boolean,
  sinceDate: LocalDate | null,
): WeekPoint[] {
  const thisWeek = weekBounds(nowMs, tz, p.weekStart);
  const trackedFrom = empty ? null : (sinceDate ?? thisWeek.from);

  const dow = (dayOfWeek(localDateOf(nowMs, tz)) - p.weekStart + 7) % 7;
  const midweek = nowMs + (3 - dow) * DAY_MS;

  const out: WeekPoint[] = [];
  for (let k = WEEK_SERIES_WEEKS - 1; k >= 0; k--) {
    const at = midweek - k * WEEK_MS;
    const wk = weekBounds(at, tz, p.weekStart);
    // 'YYYY-MM-DD' sorts lexicographically exactly as it sorts chronologically,
    // which is why every date bound in this codebase is a string comparison.
    // `toExclusive <= trackedFrom` is "the whole week is before the first day
    // we have anything for".
    const untracked = trackedFrom === null || wk.toExclusive <= trackedFrom;
    out.push({ weekStart: wk.from, hours: untracked ? null : hoursThisWeek(db, p, tz, at) });
  }
  return out;
}

export function buildMetrics(
  db: DatabaseSync,
  wire: MetricsPolicy,
  base: Policy,
  tz: string,
  nowMs: number,
): MetricsBundle {
  const p = toStorePolicy(wire, base);
  const wk = weekBounds(nowMs, tz, p.weekStart);
  const empty = countIntervals(db) === 0;

  const week = empty ? null : hoursThisWeek(db, p, tz, nowMs);
  // The previous week's bounds are this week's, shifted seven calendar days.
  const prevWeek = empty ? null : hoursThisWeek(db, p, tz, nowMs - WEEK_MS);

  // `localDateOf`, not a UTC slice and not `date('now','localtime')`: "today"
  // is the OWNER'S local day, and it has to be the same notion of a day the
  // rows were stamped with at close. Yesterday is one CALENDAR day back
  // (`addDays` goes through `Date.UTC`), so a DST boundary cannot turn it into
  // the day before that.
  const todayDate = localDateOf(nowMs, tz);
  const yesterdayDate = addDays(todayDate, -1);
  const todayH = empty ? null : hoursOnDate(db, p, todayDate);
  const prevDayH = empty ? null : hoursOnDate(db, p, yesterdayDate);

  const thisWeekAvg = avgIntervalThisWeek(db, p, tz, nowMs);
  const allAvg = avgIntervalAllTime(db, p);
  const totals = allTimeTotals(db, p);
  const longest = longestInterval(db, p);
  const days = applyThresholds(heatmap(db, p, tz, nowMs), wire.heatmapThresholdsH);

  const machines = byMachine(db, p, tz, nowMs);
  const totalMachineHours = machines.reduce((a, m) => a + m.hours, 0);
  const meta = machineMeta(db);

  const byDate = new Map(days.map((d) => [d.date, d.count]));
  const weekBars = buildWeekBars(db, p, wk.from, machines, byDate);
  const weekSeries = buildWeekSeries(db, p, tz, nowMs, empty, totals.sinceDate);

  const honesty = unionVsSum(db, p, todayDate);

  return {
    generatedAtMs: nowMs,
    policy: wire,
    weekStart: wk.from,
    week: { hours: week, prevHours: prevWeek },
    // Built exactly the way `week` is, one line above, and for the same
    // reason: the Today card and the This week card beside it must not be able
    // to disagree about which intervals count or about how two overlapping
    // Macs are merged. `hoursOnDate()` is `hoursThisWeek()` with a day's bounds.
    today: { date: todayDate, hours: todayH, prevHours: prevDayH },
    interval: {
      avgMin: thisWeekAvg.n === 0 ? null : thisWeekAvg.minutes,
      nIntervals: thisWeekAvg.n,
    },
    allTime: {
      avgMin: allAvg.n === 0 ? null : allAvg.minutes,
      nIntervals: allAvg.n,
      hoursTracked: totals.hoursTracked,
      sinceDate: totals.sinceDate,
    },
    longest: {
      singleHours: longest?.kind === "single_interval" ? longest.hours : null,
      // The machine table is populated by heartbeats pulled from the cloud, so
      // a machine we have rows for may have no label yet. Fall back to its id
      // rather than rendering a blank.
      singleMachineLabel:
        longest?.kind === "single_interval" && longest.machineId !== null
          ? (meta.get(longest.machineId)?.label ?? longest.machineId)
          : null,
      singleDate: longest?.kind === "single_interval" ? longest.localDate : null,
      mergedHours: longest?.kind === "merged_session" ? longest.hours : null,
      mergedDate: longest?.kind === "merged_session" ? longest.localDate : null,
    },
    heatmap: days,
    weekBars,
    weekSeries,
    byMachine: machines.map((m) => ({
      machineId: m.machineId,
      label: m.label,
      hours: m.hours,
      intervals: m.intervals,
      meetingHours: m.meetingHours,
      jigglerHours: m.jigglerHours,
      // Computed here so the renderer stays arithmetic-free.
      share: totalMachineHours === 0 ? 0 : m.hours / totalMachineHours,
      lastSeenMs: meta.get(m.machineId)?.lastSeenMs ?? null,
    })),
    honesty: {
      date: todayDate,
      naiveSumH: empty ? null : honesty.naiveSumH,
      unionH: empty ? null : honesty.unionH,
    },
  };
}
