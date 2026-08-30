/**
 * THE GUTTER `<ActivityCalendar>` RESERVES FOR "Mon / Wed / Fri" — recomputed
 * on our side, so the strip under the heatmap can start where the GRID starts
 * rather than where the calendar's box does.
 *
 * `react-activity-calendar` renders its weekday labels to the LEFT of the SVG
 * (`overflow: visible`, negative x) and pushes the SVG right by
 * `marginLeft: ceil(widest shown label) + 8`. The label width is measured at
 * runtime, from the real font, on the component's first client render — so it
 * is not a number anybody can hard-code, and on this machine it comes to about
 * 33 px. Everything the calendar draws therefore sits 33 px right of the box's
 * own left edge, and a sibling that starts at 0 is 33 px out.
 *
 * That was invisible while the strip's bars were anchored to the RIGHT — the
 * two elements were at opposite ends of the card and nothing lined up anyway.
 * With the bars starting at the left it is the first thing you see.
 *
 * ── WHY THIS RE-DERIVES THE NUMBER RATHER THAN READING IT ───────────────────
 * The honest alternative is to `querySelector` into the calendar's own subtree
 * and read the `marginLeft` it computed. That reaches into a third party's DOM
 * and breaks silently the day it renames a class. So we run the SAME
 * arithmetic, over the same strings, at the same font size, in an element of
 * OUR OWN: `svg > text`, `getBBox().width`, `Math.ceil`, `+ LABEL_MARGIN` — a
 * transcription of `calcTextDimensions()` and `maxWeekdayLabelWidth()` in
 * `react-activity-calendar/src/lib/label.ts`.
 *
 * Transcription is a thing that rots, so `week-strip.test.tsx` mounts the real
 * calendar and asserts our number EQUALS the `margin-left` it actually applied.
 * If the library changes its gutter arithmetic, that test fails; it does not
 * quietly go back to being 33 px out.
 */
import * as React from "react";

/** `LABEL_MARGIN` — `react-activity-calendar/src/constants.ts`. */
const LABEL_MARGIN = 8;

/** `DEFAULT_LABELS.weekdays`, Sunday first, as the library indexes them. */
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The library's `DayName`. */
export type WeekdayName = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

const DAY_INDEX: Record<WeekdayName, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * `calcTextDimensions()`, transcribed. An off-document SVG in the body's own
 * font — which is what the calendar measures in, because it sets
 * `fontFamily` from `getComputedStyle(document.body)` too.
 *
 * Returns 0 where there is no layout engine (jsdom's `getBBox` stub does the
 * same), which is exactly what the calendar reads there as well: both sides
 * come out at `0 + LABEL_MARGIN`, and the test that pins them together is
 * still comparing two numbers that were computed, not two constants.
 */
function textWidth(text: string, fontSize: number): number {
  if (typeof document === "undefined" || typeof window === "undefined") return 0;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  svg.style.fontFamily = window.getComputedStyle(document.body).fontFamily;
  svg.style.fontSize = `${String(fontSize)}px`;

  const node = document.createElementNS(ns, "text");
  node.textContent = text;
  svg.appendChild(node);
  document.body.appendChild(svg);
  const { width } = node.getBBox();
  document.body.removeChild(svg);

  return width;
}

/**
 * How far right of its container `<ActivityCalendar>` will start drawing.
 *
 * `shown` is the component's `showWeekdayLabels` array; an empty one means no
 * labels, no gutter, and the calendar's `shouldShow` is false for the same
 * reason.
 */
export function measureWeekdayGutter(
  shown: readonly WeekdayName[],
  fontSize: number,
): number {
  if (shown.length === 0) return 0;
  let widest = 0;
  for (const name of shown) {
    const label = WEEKDAY_LABELS[DAY_INDEX[name]] ?? "";
    widest = Math.max(widest, Math.ceil(textWidth(label, fontSize)));
  }
  return widest + LABEL_MARGIN;
}

/**
 * The gutter, measured after mount.
 *
 * Zero on the first render, exactly like the calendar's own `isClient` gate —
 * so the two are aligned in both passes rather than agreeing only once the
 * second one lands. `shown` must be a stable reference; `App.tsx` holds it as
 * a module constant, which is also what it passes to the calendar.
 */
export function useWeekdayGutter(
  shown: readonly WeekdayName[],
  fontSize: number,
): number {
  const [gutter, setGutter] = React.useState(0);
  React.useEffect(() => {
    setGutter(measureWeekdayGutter(shown, fontSize));
  }, [shown, fontSize]);
  return gutter;
}
