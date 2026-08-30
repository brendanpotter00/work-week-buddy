/**
 * "How many hours did I work each of the past few weeks" — the owner's ask,
 * verbatim: *"I want a way to see how many hours I worked per week… I need a
 * way to see how many hours I worked the past few weeks."*
 *
 * The answer is a strip of sixteen weekly bars under the heatmap, each carrying
 * a printed hour value and a date. It is option 6 of the seven mockups in
 * `.lavish/weekly-history.html` (`stripFew`), and that file is a RENDERED
 * mockup rather than a wireframe — the geometry, the type scale and the greys
 * below are carried across from it rather than reinvented.
 *
 * ── WHY SIXTEEN AND NOT FIFTY-THREE ─────────────────────────────────────────
 * The strip is the width of the heatmap's grid, which is 739 px at every window
 * width. Fifty-three weeks is a 14 px pitch; `44.1` set at 11 px measures
 * 24.31 px, so the values would collide and the strip would be another picture
 * of a year — which the heatmap directly above it already is. Sixteen weeks
 * gives 46.2 px, which fits a value AND a date.
 *
 * THE ACCEPTED COST: at sixteen the bars no longer line up with the 53 columns
 * above them. The owner saw that in the mockup and chose it anyway, so it is
 * not a defect to be worked around, and the UI does not apologise for it.
 *
 * ── `null` IS DRAWN AS NOTHING, `0` IS DRAWN ────────────────────────────────
 * `WeekPoint.hours === null` means the week ended before tracking began: no
 * bar, no value. `0` means a tracked week with nothing countable in it: a
 * visible floor-height bar, because that is a week off and it is a fact. The
 * owner has two weeks of history, so most of this strip is `null` today — the
 * empty case is the ordinary one here, not the edge.
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
 * "last 16 weeks" over two bars is a heading that lies, so the count is the
 * number of weeks actually DRAWN and never the length of the array. Main sends
 * a fixed sixteen entries — most of them `null` on this owner's machine — so
 * that the pitch stays constant; the words have to come from the data instead.
 */
export function weekCountLabel(weeks: readonly WeekPoint[]): string {
  const n = weeks.filter((w) => w.hours !== null).length;
  if (n === 0) return "Week totals";
  if (n === 1) return "Week totals · last week";
  return `Week totals · last ${String(n)} weeks`;
}

export interface WeekStripProps {
  /** Oldest first, fixed length. `MetricsBundle.weekSeries`. */
  weeks: readonly WeekPoint[];
  /** `HEATMAP_RAMP[resolvedTheme]` — the calendar's own five stops. */
  ramp: Ramp;
}

export function WeekStrip({ weeks, ramp }: WeekStripProps): React.ReactElement {
  const ceiling = ceilingFor(weeks);
  const pitch = weeks.length === 0 ? 0 : HEATMAP_GRID_W / weeks.length;
  // The newest week is the one still being lived, and it is the one the "This
  // week" stat card is showing. It gets the lighter stop and the stronger
  // label, exactly as the mockup's `.cur` does — a full-strength bar would read
  // as a finished week that happened to be short.
  const currentIndex = weeks.length - 1;

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
      // below, from the mockup.
      className="mt-[9px] border-t border-border pt-2"
      style={{ width: HEATMAP_GRID_W }}
    >
      {/* Three absolutely-positioned layers over one shared x-scale, so a 24 px
          number can hang over a 22 px bar without either pushing the other
          around. A flex row of cells would let one long label re-space the
          whole strip. */}
      <div className="relative" style={{ height: VALUE_ROW_H }}>
        {weeks.map((w, i) =>
          w.hours === null ? null : (
            <span
              key={w.weekStart}
              data-slot="week-strip-value"
              data-week={w.weekStart}
              className={
                "absolute -translate-x-1/2 whitespace-nowrap text-[10.5px] leading-[14px] tabular-nums " +
                (i === currentIndex ? "font-medium text-foreground" : "text-muted-foreground")
              }
              style={{ left: i * pitch + pitch / 2 }}
            >
              {formatHours(w.hours)}
            </span>
          ),
        )}
      </div>

      <div className="relative border-b border-input" style={{ height: BAR_BOX_H }}>
        {weeks.map((w, i) =>
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
                left: i * pitch + pitch / 2,
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
        {weeks.map((w, i) =>
          // The date follows the bar. Sixteen dates over two bars would be the
          // same lie the heading is not allowed to tell: those weeks are not
          // "0 h", they are weeks this database knows nothing about.
          w.hours === null ? null : (
            <span
              key={w.weekStart}
              data-slot="week-strip-date"
              data-week={w.weekStart}
              className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] leading-[14px] text-muted-foreground tabular-nums"
              style={{ left: i * pitch + pitch / 2 }}
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
