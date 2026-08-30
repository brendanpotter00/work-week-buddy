/**
 * "How many hours did I work each of the past few weeks" — the owner's ask,
 * verbatim: *"I want a way to see how many hours I worked per week… I need a
 * way to see how many hours I worked the past few weeks."*
 *
 * The answer is a strip of weekly bars under the heatmap, each carrying a
 * printed hour value and a date, oldest at the LEFT. It is option 6 of the
 * seven mockups in `.lavish/weekly-history.html` (`stripFew`), and that file is
 * a RENDERED mockup rather than a wireframe — the geometry, the type scale and
 * the greys below are carried across from it rather than reinvented.
 *
 * ── SIXTEEN IS THE PITCH, NOT THE NUMBER OF BARS ────────────────────────────
 * The strip is the width of the heatmap's grid, which is 739 px at every window
 * width. Fifty-three weeks is a 14 px pitch; `44.1` set at 11 px measures
 * 24.31 px, so the values would collide and the strip would be another picture
 * of a year — which the heatmap directly above it already is. Sixteen weeks
 * gives 46.2 px, which fits a value AND a date.
 *
 * So sixteen survives twice: as `MAX_WEEKS`, the furthest back this looks, and
 * as `WEEK_PITCH` — the 46.19 px each week is allotted **whether two of them
 * are drawn or sixteen**. What does not survive is drawing sixteen slots when
 * there is data for two.
 *
 * ── WHY IT IS BUILT LEFT TO RIGHT ───────────────────────────────────────────
 * The owner, on the first version: *"can you build it left to right rather than
 * right to left? It makes more sense for the newest week to be to the right and
 * August 17 to be at the far left, because that aligns with the grid."*
 *
 * The ORDER was always oldest-left; what was wrong was the ANCHOR. Sixteen
 * slots were laid out however few were filled, and the empty ones came first,
 * so two weeks of history put both bars hard against the right edge of a card
 * whose heatmap starts at the left. At 880 px they were at opposite ends of the
 * same box, and it read as broken.
 *
 * Now only the weeks that HAVE data get a slot, and the plot grows rightward as
 * history accumulates — which is exactly what the heatmap above it does, since
 * `heatmap()` returns only the days a row exists for.
 *
 * THE TRAP, and the reason the first version anchored right: the obvious fix is
 * to drop the empty slots and divide the width by what is left. At two weeks
 * that is a 369 px pitch — two bars a third of a card apart, re-spacing
 * themselves every time a week rolls over. The pitch has to stay the constant
 * `HEATMAP_GRID_W / MAX_WEEKS`; only the SLOT COUNT may move. Keeping the pitch
 * and giving up the left edge was half of that fix.
 *
 * THE ACCEPTED COST, unchanged: at sixteen the bars do not line up with the 53
 * columns above them, because a week is 46 px here and 14 px there. The owner
 * saw that in the mockup and chose it anyway. The first bar and the first
 * column do now share an edge, which is what he asked for.
 *
 * ── `null` IS DRAWN AS NOTHING, `0` IS DRAWN ────────────────────────────────
 * `WeekPoint.hours === null` means the week ended before tracking began: no
 * bar, no value. `0` means a tracked week with nothing countable in it: a
 * visible floor-height bar, because that is a week off and it is a fact. Main
 * still sends a fixed sixteen entries — the owner has two weeks of history, so
 * fourteen of them are `null` today — and the LEADING run of them is what this
 * file now declines to reserve space for.
 *
 * ── ONE GREY VOCABULARY ─────────────────────────────────────────────────────
 * Every shade comes out of `HEATMAP_RAMP`, the five-stop ramp `App.tsx` hoisted
 * out of `<ActivityCalendar>` so the "This week" bars could share it. A second
 * grey scale invented here would drift from it the first time either was
 * touched, and they sit nine pixels apart.
 */
import * as React from "react";

import type { Ramp } from "@/renderer/lib/machine-shades";
import { formatMonthDay } from "@/renderer/lib/format-date";
import { formatHours } from "@/shared/format";
import type { WeekPoint } from "@/shared/ipc-types";

/**
 * The heatmap grid's width: 53 columns at an 11 px block and a 3 px margin,
 * less the trailing margin. It is what `<ActivityCalendar blockSize={11}
 * blockMargin={3}>` lays out in `App.tsx` and it does NOT shrink — which is why
 * a wider window buys this strip nothing, and why the pitch below can be a
 * constant. `week-strip.test.tsx` pins the two against each other.
 */
export const HEATMAP_GRID_W = 53 * (11 + 3) - 3;

/**
 * The furthest back the strip looks. Mirrors `WEEK_SERIES_WEEKS` in
 * `src/main/metrics.ts` — the renderer may not import from main, so the test
 * imports both and asserts they are one number. A longer series is TRIMMED to
 * its newest sixteen here rather than squeezed into the width.
 */
export const MAX_WEEKS = 16;

/**
 * 46.19 px, and a constant on purpose: a bar must not move or change width
 * because a sixteenth week appeared. Divide by the number of weeks DRAWN
 * instead and two weeks of history come out as two slabs 369 px apart.
 */
export const WEEK_PITCH = HEATMAP_GRID_W / MAX_WEEKS;

/**
 * The bar height a "full" week reaches. 46 h is roughly nine hours across five
 * days plus a Saturday — a hard week, near the top of the box but not at it.
 *
 * It is a FLOOR on the scale, not a cap: a 60-hour week raises the ceiling for
 * the whole strip rather than clipping flat, because two different weeks drawn
 * the same height is the picture lying about the numbers printed above it.
 */
const CEILING_H = 46;

const BAR_BOX_H = 34;
const BAR_W = 22;
/** A tracked week with no work still has to be visible. */
const ZERO_BAR_H = 2;

const VALUE_ROW_H = 15;
const DATE_ROW_H = 16;

function ceilingFor(weeks: readonly WeekPoint[]): number {
  let max = CEILING_H;
  for (const w of weeks) if (w.hours !== null && w.hours > max) max = w.hours;
  return max;
}

/**
 * The slots the strip lays out: the newest `MAX_WEEKS`, with the LEADING run of
 * untracked weeks dropped so the oldest week that exists sits at x = 0.
 *
 * Only the leading run. A `null` BETWEEN two tracked weeks keeps its slot — it
 * is a hole in the middle of the history, and closing it would slide every week
 * after it one column left of where the calendar puts the same date.
 */
export function drawnWeeks(weeks: readonly WeekPoint[]): readonly WeekPoint[] {
  const recent = weeks.length > MAX_WEEKS ? weeks.slice(weeks.length - MAX_WEEKS) : weeks;
  const first = recent.findIndex((w) => w.hours !== null);
  return first === -1 ? [] : recent.slice(first);
}

/**
 * "last 16 weeks" over two bars is a heading that lies, so the count is the
 * number of weeks actually DRAWN and never the length of the array. Main sends
 * a fixed sixteen entries — most of them `null` on this owner's machine — so
 * the words have to come from the data instead.
 */
export function weekCountLabel(weeks: readonly WeekPoint[]): string {
  const n = drawnWeeks(weeks).filter((w) => w.hours !== null).length;
  if (n === 0) return "Week totals";
  if (n === 1) return "Week totals · last week";
  return `Week totals · last ${String(n)} weeks`;
}

export interface WeekStripProps {
  /** Oldest first. `MetricsBundle.weekSeries`. */
  weeks: readonly WeekPoint[];
  /** `HEATMAP_RAMP[resolvedTheme]` — the calendar's own five stops. */
  ramp: Ramp;
  /**
   * The width `<ActivityCalendar>` reserved for its weekday labels, from
   * `useWeekdayGutter()`. The strip is shifted by the same amount, so bar zero
   * and grid column zero share an edge — see `lib/heatmap-gutter.ts`.
   */
  gutterPx: number;
}

export function WeekStrip({ weeks, ramp, gutterPx }: WeekStripProps): React.ReactElement {
  const slots = drawnWeeks(weeks);
  const ceiling = ceilingFor(slots);
  // The newest week is the one still being lived, and it is the one the "This
  // week" stat card is showing. It gets the lighter stop and the stronger
  // label, exactly as the mockup's `.cur` does — a full-strength bar would read
  // as a finished week that happened to be short.
  const currentIndex = slots.length - 1;
  /** The centre of slot `i`. Left-anchored: slot 0 is the oldest week there is. */
  const centreOf = (i: number): number => i * WEEK_PITCH + WEEK_PITCH / 2;

  /**
   * Stops 1, 2 and 3 of the heatmap's ramp.
   *
   * STOP 0 IS DELIBERATELY NEVER REACHED. It is the background-adjacent stop —
   * #F1F0EE on a white card is 1.14:1, #242424 on a #202020 one is 1.05:1 — so
   * a bar painted in it is an invisible bar, which is exactly the reason
   * `machineShades()` throws it away too. The heatmap may use it, because an
   * untracked day is *supposed* to disappear; a tracked week that came to zero
   * is not, and the difference between "nothing here" and "nothing happened" is
   * the whole point of this strip.
   */
  const shadeFor = (hours: number, i: number): string =>
    i === currentIndex ? ramp[2] : hours <= 0 ? ramp[1] : ramp[3];

  return (
    <div
      data-slot="week-strip"
      // The rule is the seam with the calendar above; 9 px above it and 8 px
      // below, from the mockup. `marginLeft` is the calendar's weekday-label
      // gutter, so the rule, the bars and the baseline all begin at the grid's
      // first column rather than at the card's edge.
      className="mt-[9px] border-t border-border pt-2"
      style={{ width: HEATMAP_GRID_W, marginLeft: gutterPx }}
    >
      {/* Three absolutely-positioned layers over one shared x-scale, so a 24 px
          number can hang over a 22 px bar without either pushing the other
          around. A flex row of cells would let one long label re-space the
          whole strip. */}
      <div className="relative" style={{ height: VALUE_ROW_H }}>
        {slots.map((w, i) =>
          w.hours === null ? null : (
            <span
              key={w.weekStart}
              data-slot="week-strip-value"
              data-week={w.weekStart}
              className={
                "absolute -translate-x-1/2 whitespace-nowrap text-[10.5px] leading-[14px] tabular-nums " +
                (i === currentIndex ? "font-medium text-foreground" : "text-muted-foreground")
              }
              style={{ left: centreOf(i) }}
            >
              {formatHours(w.hours)}
            </span>
          ),
        )}
      </div>

      <div className="relative border-b border-input" style={{ height: BAR_BOX_H }}>
        {slots.map((w, i) =>
          // NOT a zero-height bar and NOT a hidden one: a week before tracking
          // began is absent from the DOM, so "no data" and "no work" cannot end
          // up as the same pixels or the same element.
          w.hours === null ? null : (
            <span
              key={w.weekStart}
              data-slot="week-strip-bar"
              data-week={w.weekStart}
              data-hours={String(w.hours)}
              // The resolved hex, for the tests: jsdom has no cascade, so a
              // shade asserted through `getComputedStyle` would pass on any
              // palette at all.
              data-shade={shadeFor(w.hours, i)}
              title={`${formatHours(w.hours)} h in the week of ${formatMonthDay(w.weekStart)}`}
              className="absolute bottom-0 block -translate-x-1/2 rounded-[1px]"
              style={{
                left: centreOf(i),
                width: BAR_W,
                height:
                  w.hours <= 0
                    ? ZERO_BAR_H
                    : Math.max(ZERO_BAR_H, (w.hours / ceiling) * BAR_BOX_H),
                backgroundColor: shadeFor(w.hours, i),
              }}
            />
          ),
        )}
      </div>

      <div className="relative" style={{ height: DATE_ROW_H }}>
        {slots.map((w, i) =>
          // The date follows the bar. A date over an empty slot would be the
          // same lie the heading is not allowed to tell: that week is not
          // "0 h", it is a week this database knows nothing about.
          w.hours === null ? null : (
            <span
              key={w.weekStart}
              data-slot="week-strip-date"
              data-week={w.weekStart}
              className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] leading-[14px] text-muted-foreground tabular-nums"
              style={{ left: centreOf(i) }}
            >
              {formatMonthDay(w.weekStart)}
            </span>
          ),
        )}
      </div>

      <div
        data-slot="week-strip-caption"
        className="mt-[7px] text-[11px] text-muted-foreground"
      >
        {weekCountLabel(weeks)}
      </div>
    </div>
  );
}
