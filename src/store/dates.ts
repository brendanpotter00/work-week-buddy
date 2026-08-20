/**
 * Civil dates.
 *
 * Two rules, both from `docs/IMPL_STORE_SYNC.md`:
 *
 * 1. `local_date` is minted client-side at close, in the interval's own IANA
 *    zone, and stored. Converting UTC to a per-row zone is not an immutable SQL
 *    expression, and storing it turns every heatmap query into a plain
 *    `GROUP BY`. It also stays correct when you travel, because the row
 *    remembers the zone it happened in.
 *
 * 2. Week boundaries are computed **here**, in TypeScript, from the display
 *    timezone, and passed into SQL as bound parameters. Never
 *    `date(…, 'localtime')`: SQLite's `localtime` uses the *host process's*
 *    current offset, so it is DST-naive and simply wrong when travelling.
 *
 * All arithmetic below is on civil dates through `Date.UTC`, which has no DST
 * to be wrong about. The only place a timezone is consulted is the single
 * `Intl.DateTimeFormat` conversion from an instant to a civil date.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    // An unknown IANA zone throws RangeError here, loudly, at the point of the
    // mistake — rather than silently attributing a day to the wrong date.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 'YYYY-MM-DD' for an instant, in the given IANA zone. */
export function localDateOf(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) throw new Error(`localDateOf: not an instant: ${String(ms)}`);
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === t);
    if (p === undefined) throw new Error(`localDateOf: no ${t} part for tz ${tz}`);
    return p.value;
  };
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

function parse(localDate: string): { y: number; m: number; d: number } {
  if (!DATE_RE.test(localDate)) throw new Error(`not a YYYY-MM-DD date: ${localDate}`);
  return {
    y: Number(localDate.slice(0, 4)),
    m: Number(localDate.slice(5, 7)),
    d: Number(localDate.slice(8, 10)),
  };
}

/** Calendar-day arithmetic. DST cannot reach it: UTC has no DST. */
export function addDays(localDate: string, n: number): string {
  const { y, m, d } = parse(localDate);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday, for a civil date. Zone-independent. */
export function dayOfWeek(localDate: string): number {
  const { y, m, d } = parse(localDate);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The `weekStart`-aligned week containing `localDate`. */
export function startOfWeek(localDate: string, weekStart: 0 | 1): string {
  const back = (dayOfWeek(localDate) - weekStart + 7) % 7;
  return addDays(localDate, -back);
}

export interface WeekBounds {
  /** Inclusive `local_date` lower bound. */
  readonly from: string;
  /** Exclusive `local_date` upper bound. */
  readonly toExclusive: string;
}

/** The current week in the display timezone, as two bindable date strings. */
export function weekBounds(nowMs: number, tz: string, weekStart: 0 | 1): WeekBounds {
  const from = startOfWeek(localDateOf(nowMs, tz), weekStart);
  return { from, toExclusive: addDays(from, 7) };
}
