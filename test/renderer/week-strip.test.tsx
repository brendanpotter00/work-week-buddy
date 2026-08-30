// @vitest-environment jsdom
/**
 * The weekly strip under the heatmap — the owner's *"I need a way to see how
 * many hours I worked the past few weeks"*.
 *
 * Five failures are being held off here, and none of them throws.
 *
 *  1. **THE HEADING LIES.** Main always sends sixteen entries so the pitch
 *     stays constant, and fourteen of them are `null` on the owner's machine.
 *     A caption that read the array's LENGTH would say "last 16 weeks" over two
 *     bars — a sentence the picture underneath flatly contradicts.
 *
 *  2. **A WEEK NOBODY MEASURED IS DRAWN AS A WEEK OFF.** `null` and `0` are
 *     different pixels (PRD §4). A zero-height bar for an untracked week claims
 *     the owner did not work in a week the app was not even installed for.
 *
 *  3. **A GREY DISAPPEARS INTO THE CARD.** Monochrome is one careless stop from
 *     invisible, in one theme only, with the numbers still right. So the shades
 *     are asserted as CONTRAST RATIOS against the real `--card` in both themes,
 *     read out of `index.css`, rather than as hex strings that would pass just
 *     as happily on a palette nobody can see.
 *
 *  4. **THE BARS DRIFT BACK TO THE RIGHT EDGE, OR SPREAD OUT.** Those are the
 *     two ways to lay this strip out wrong, and they are opposite mistakes: a
 *     fixed sixteen slots puts two weeks of history at the far right of a card
 *     whose heatmap starts at the left (the bug the owner reported), and a pitch
 *     of `width / drawn` puts them 369px apart as two slabs. So the anchor and
 *     the pitch are asserted separately: bar zero at x = 0, and the same `left`
 *     for the same slot whether two weeks are drawn or sixteen.
 *
 *  5. **THE STRIP IS 35PX LEFT OF THE GRID IT SITS UNDER.** `<ActivityCalendar>`
 *     shifts everything it draws right by the width of its "Mon / Wed / Fri"
 *     labels, measured from the real font at runtime.
 *     `lib/heatmap-gutter.ts` recomputes that number rather than reading it out
 *     of a third party's DOM, and a transcription is a thing that rots — so the
 *     margin the strip applies is asserted against the one the calendar
 *     actually applied, in the same mounted DOM.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import {
  HEATMAP_GRID_W,
  MAX_WEEKS,
  WEEK_PITCH,
  drawnWeeks,
  weekCountLabel,
} from "@/renderer/components/week-strip";
import { measureWeekdayGutter } from "@/renderer/lib/heatmap-gutter";
import { contrastRatio, type Ramp } from "@/renderer/lib/machine-shades";
import { WINDOW_SIZE } from "@/shared/constants";
import type { MetricsBundle, WeekPoint } from "@/shared/ipc-types";
import {
  cardByLabel,
  cardValue,
  defaultHandlers,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  renderApp,
  weekSeriesPoints,
} from "./harness";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

/** The ramp `App.tsx` owns, read from source so a palette edit has to come here. */
function rampFromApp(theme: "light" | "dark"): Ramp {
  const m = new RegExp(`${theme}: \\[([^\\]]+)\\]`).exec(read("src/renderer/App.tsx"));
  if (!m) throw new Error(`no ${theme} ramp in App.tsx`);
  const stops = m[1]!.split(",").map((s) => s.trim().replace(/"/g, ""));
  expect(stops).toHaveLength(5);
  return stops as unknown as Ramp;
}

/**
 * `WEEK_SERIES_WEEKS` out of main, READ FROM SOURCE rather than imported: this
 * suite runs in jsdom, and importing `src/main/metrics.ts` drags `node:sqlite`
 * into a browser environment that cannot bundle it. The point stands either
 * way — how many weeks main sends decides the strip's pitch, so the two numbers
 * are not allowed to drift apart quietly.
 */
function weekSeriesWeeksInMain(): number {
  const m = /export const WEEK_SERIES_WEEKS = (\d+);/.exec(read("src/main/metrics.ts"));
  if (!m) throw new Error("no WEEK_SERIES_WEEKS in src/main/metrics.ts");
  return Number(m[1]);
}

/** `--card` out of `:root` (light) and `.dark`. */
function cardColour(theme: "light" | "dark"): string {
  const css = read("src/renderer/index.css");
  const block = theme === "light" ? /:root \{([\s\S]*?)\}/ : /\.dark \{([\s\S]*?)\}/;
  const found = block.exec(css);
  if (!found) throw new Error(`no ${theme} block in index.css`);
  const card = /--card:\s*(#[0-9A-Fa-f]{6})/.exec(found[1]!);
  if (!card) throw new Error(`no --card in the ${theme} block`);
  return card[1]!;
}

const RAMP = { light: rampFromApp("light"), dark: rampFromApp("dark") } as const;
const CARD = { light: cardColour("light"), dark: cardColour("dark") } as const;

const WEEKS = 16;
const THIS_WEEK = "2026-08-17";

async function mount(
  bundle: MetricsBundle,
  theme: "light" | "dark" = "light",
): Promise<HTMLElement> {
  installBridge(makeBridge(defaultHandlers(bundle)));
  const { container } = renderApp(<App />, theme);
  await waitFor(() => expect(container.querySelector('[data-slot="week-strip"]')).not.toBeNull());
  return container;
}

const strip = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector<HTMLElement>('[data-slot="week-strip"]');
  if (el === null) throw new Error("no [data-slot=week-strip] rendered");
  return el;
};

const part = (c: HTMLElement, kind: "bar" | "value" | "date"): HTMLElement[] =>
  [...strip(c).querySelectorAll<HTMLElement>(`[data-slot="week-strip-${kind}"]`)];

const caption = (c: HTMLElement): string =>
  strip(c).querySelector('[data-slot="week-strip-caption"]')?.textContent ?? "";

/** A bundle whose strip is `hours`, newest last, over a fixed sixteen weeks. */
function bundleWith(hours: readonly (number | null)[]): MetricsBundle {
  const series: WeekPoint[] = weekSeriesPoints(
    THIS_WEEK,
    WEEKS,
    (back) => hours[hours.length - 1 - back] ?? null,
  );
  const newest = series.at(-1)!.hours;
  return metricsBundle({
    weekSeries: series,
    // The card and the newest bar are the same week; a fixture that let them
    // differ would make the agreement test agree with itself.
    week: { hours: newest, prevHours: series.at(-2)!.hours },
  });
}

/** The owner's machine today: two tracked weeks, fourteen unobserved ones. */
const TWO_WEEKS = bundleWith([40.8, 36.5]);

describe("the heading counts what is drawn, not what was sent", () => {
  it("says 2 — never 16 — when there are two weeks of history", async () => {
    const c = await mount(TWO_WEEKS);
    // The bundle really does carry sixteen entries; the caption must not.
    expect(TWO_WEEKS.weekSeries).toHaveLength(16);
    expect(caption(c)).toBe("Week totals · last 2 weeks");
    expect(caption(c)).not.toContain("16");
  });

  it("says 16 once there are sixteen", async () => {
    const c = await mount(metricsBundle());
    expect(caption(c)).toBe("Week totals · last 16 weeks");
  });

  it("counts a tracked zero week, because a zero week is data", () => {
    // The distinction the whole component turns on, at the level of the words:
    // `0` is a week that happened, `null` is a week nobody watched.
    const pts = (hours: readonly (number | null)[]): WeekPoint[] =>
      hours.map((h, i) => ({ weekStart: `2026-01-${String(i + 1).padStart(2, "0")}`, hours: h }));

    expect(weekCountLabel(pts([null, null, 0, 12.5]))).toBe("Week totals · last 2 weeks");
    expect(weekCountLabel(pts([null, 7]))).toBe("Week totals · last week");
    expect(weekCountLabel(pts([null, null]))).toBe("Week totals");
    expect(weekCountLabel([])).toBe("Week totals");
  });

  it("says nothing about weeks on a first run, rather than 0", async () => {
    // A brand-new database sends sixteen `null`s. "last 0 weeks" would be a
    // sentence about weeks that do not exist.
    const c = await mount(bundleWith([]));
    expect(caption(c)).toBe("Week totals");
    expect(part(c, "bar")).toHaveLength(0);
  });
});

describe("a week before tracking began", () => {
  it("is absent from the strip — no bar, no value, no date", async () => {
    const c = await mount(TWO_WEEKS);

    const drawn = part(c, "bar").map((el) => el.dataset["week"]);
    expect(drawn).toEqual(["2026-08-10", THIS_WEEK]);
    expect(part(c, "value").map((el) => el.dataset["week"])).toEqual(drawn);
    expect(part(c, "date").map((el) => el.dataset["week"])).toEqual(drawn);

    // The untracked weeks are in the bundle and nowhere in the DOM. Not a
    // zero-height bar, not a hidden one: absent, so no later change can make
    // "no data" and "no work" the same element.
    for (const w of TWO_WEEKS.weekSeries.filter((x) => x.hours === null)) {
      expect(strip(c).querySelector(`[data-week="${w.weekStart}"]`)).toBeNull();
    }
  });

  it("does not reserve a slot at the LEFT, where it would push the bars off the edge", async () => {
    // The bug the owner reported: sixteen slots were laid out however few were
    // filled, so his two weeks sat at the far right of a card whose heatmap
    // starts at the far left. The oldest week there IS goes at x = 0.
    const c = await mount(TWO_WEEKS);
    const bars = part(c, "bar");

    expect(bars).toHaveLength(2);
    expect(bars[0]!.style.left).toBe(`${String(WEEK_PITCH / 2)}px`);
    expect(bars[1]!.style.left).toBe(`${String(WEEK_PITCH + WEEK_PITCH / 2)}px`);
    // …and nothing is anywhere near the right-hand end of the 739px plot.
    for (const bar of bars) expect(Number.parseFloat(bar.style.left)).toBeLessThan(HEATMAP_GRID_W / 2);
  });
});

describe("the pitch, which is the one thing that may not move", () => {
  // The opposite mistake to the one above, and the reason the first version
  // anchored right: drop the empty slots, divide the width by what is left, and
  // two weeks of history come out as two slabs 369px apart that re-space
  // themselves every time a week rolls over.
  it("puts slot n in the same place whether two weeks are drawn or sixteen", async () => {
    const two = await mount(TWO_WEEKS);
    const full = await mount(metricsBundle());

    const left = (el: HTMLElement): string => el.style.left;
    const twoBars = part(two, "bar");
    const fullBars = part(full, "bar");
    expect(twoBars).toHaveLength(2);
    expect(fullBars).toHaveLength(16);
    expect(left(twoBars[0]!)).toBe(left(fullBars[0]!));
    expect(left(twoBars[1]!)).toBe(left(fullBars[1]!));
  });

  it("draws a bar the same width at two weeks and at sixteen", async () => {
    const two = part(await mount(TWO_WEEKS), "bar");
    const full = part(await mount(metricsBundle()), "bar");
    expect(two[0]!.style.width).toBe(full[0]!.style.width);
    // The gap between neighbours is the pitch, in both strips.
    const gap = (bars: HTMLElement[]): number =>
      Number.parseFloat(bars[1]!.style.left) - Number.parseFloat(bars[0]!.style.left);
    expect(gap(two)).toBeCloseTo(WEEK_PITCH, 10);
    expect(gap(full)).toBeCloseTo(WEEK_PITCH, 10);
  });

  it("is the pitch sixteen weeks would give, because sixteen is what main sends", () => {
    // If main ever sent a different number of weeks, the bars would silently
    // change width. The renderer may not import from main, so the two constants
    // are two constants — and this is what stops them drifting apart.
    expect(MAX_WEEKS).toBe(weekSeriesWeeksInMain());
    expect(WEEK_PITCH).toBeCloseTo(46.19, 2);
  });
});

describe("more history than the strip can hold", () => {
  const twentyWeeks = (): MetricsBundle => {
    const series = weekSeriesPoints(THIS_WEEK, 20, (back) => 20 + back);
    return metricsBundle({
      weekSeries: series,
      week: { hours: series.at(-1)!.hours, prevHours: series.at(-2)!.hours },
    });
  };

  it("draws the most recent sixteen, still oldest-left", async () => {
    const c = await mount(twentyWeeks());
    const drawn = part(c, "bar").map((el) => el.dataset["week"]);

    expect(drawn).toHaveLength(MAX_WEEKS);
    // The four oldest of the twenty are dropped, not squeezed in: the newest is
    // still last, and the first bar is fifteen weeks before it.
    expect(drawn.at(-1)).toBe(THIS_WEEK);
    expect(drawn[0]).toBe("2026-05-04");
    expect([...drawn].sort()).toEqual(drawn);
    expect(part(c, "bar")[0]!.style.left).toBe(`${String(WEEK_PITCH / 2)}px`);
  });

  it("counts sixteen in the heading, not twenty", async () => {
    expect(caption(await mount(twentyWeeks()))).toBe("Week totals · last 16 weeks");
  });

  it("keeps an untracked week in the MIDDLE, because that is a hole and not a start", () => {
    // Only the LEADING run of `null`s is dropped. Closing a gap in the middle
    // would slide every week after it one column left of where the calendar
    // puts the same date.
    const pts = (hours: readonly (number | null)[]): WeekPoint[] =>
      hours.map((h, i) => ({ weekStart: `2026-01-${String(i + 1).padStart(2, "0")}`, hours: h }));

    expect(drawnWeeks(pts([null, null, 12, null, 8]))).toEqual(pts([null, null, 12, null, 8]).slice(2));
    expect(drawnWeeks(pts([null, null]))).toEqual([]);
    expect(drawnWeeks([])).toEqual([]);
  });
});

describe("a tracked week with no work", () => {
  it("is a drawn bar reading 0.0, not a gap", async () => {
    // He was being measured and he did not work. That is a fact about the week
    // and the strip has to state it; a hole would read as missing data.
    const c = await mount(bundleWith([31.2, 0, 18.4]));

    const bars = part(c, "bar");
    expect(bars).toHaveLength(3);

    const zero = bars[1]!;
    expect(zero.dataset["hours"]).toBe("0");
    expect(Number.parseFloat(zero.style.height)).toBeGreaterThan(0);
    expect(
      part(c, "value").find((el) => el.dataset["week"] === zero.dataset["week"])?.textContent,
    ).toBe("0.0");
  });

  it("is a different colour from a week nobody measured, which has no bar at all", async () => {
    const c = await mount(bundleWith([31.2, 0, 18.4]));
    const bars = part(c, "bar");
    // Three bars for three tracked weeks; the thirteen `null`s contribute none.
    expect(bars).toHaveLength(3);
    expect(bars[1]!.dataset["shade"]).not.toBe(bars[0]!.dataset["shade"]);
  });
});

describe("the newest bar and the This week card", () => {
  it("print the same number, because they are the same query", async () => {
    // The failure this guards is two visible figures disagreeing by a tenth on
    // one screen. Main builds both from `hoursThisWeek()` over the same bounds;
    // this asserts the renderer does not undo that on the way to the pixels.
    const c = await mount(TWO_WEEKS);

    const newest = part(c, "value").at(-1);
    expect(newest?.dataset["week"]).toBe(TWO_WEEKS.weekStart);
    expect(newest?.textContent).toBe(cardValue(cardByLabel(c, "This week")));
    expect(newest?.textContent).toBe("36.5");
  });

  it("marks the newest week as the one still being lived", async () => {
    // Lighter shade, stronger label: a full-strength bar would read as a
    // finished week that happened to be short.
    const c = await mount(metricsBundle());
    const bars = part(c, "bar");
    expect(bars.at(-1)!.dataset["shade"]).toBe(RAMP.light[2]);
    expect(bars.at(-2)!.dataset["shade"]).toBe(RAMP.light[3]);
    expect(part(c, "value").at(-1)!.className).toContain("text-foreground");
    expect(part(c, "value").at(-2)!.className).toContain("text-muted-foreground");
  });
});

describe("the greys", () => {
  it("are the heatmap's ramp and nothing else, in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      const c = await mount(bundleWith([31.2, 0, 18.4]), theme);
      for (const bar of part(c, "bar")) {
        expect(RAMP[theme]).toContain(bar.dataset["shade"]);
      }
    }
  });

  it("never reaches the stop that IS the card", async () => {
    // Stop 0 is 1.14:1 on the light card and 1.05:1 on the dark one. The
    // heatmap can use it — an untracked day is supposed to vanish — but a
    // tracked zero week is not, and that is the bar most at risk of getting it.
    for (const theme of ["light", "dark"] as const) {
      expect(contrastRatio(RAMP[theme][0], CARD[theme])).toBeLessThan(1.2);
      const c = await mount(bundleWith([31.2, 0, 18.4]), theme);
      for (const bar of part(c, "bar")) {
        expect(bar.dataset["shade"]).not.toBe(RAMP[theme][0]);
      }
    }
  });

  it("stay legible on the card in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      const c = await mount(bundleWith([31.2, 0, 18.4]), theme);
      const shades = part(c, "bar").map((b) => b.dataset["shade"] ?? "");

      // Measured: zero 1.53/1.43, current 2.48/2.44, a worked week 5.55/4.72.
      // The zero bar is a deliberate 2px whisper, but a whisper you can find.
      for (const shade of shades) {
        expect(contrastRatio(shade, CARD[theme])).toBeGreaterThan(1.35);
      }
      expect(contrastRatio(shades[0]!, CARD[theme])).toBeGreaterThan(4.5);
      expect(contrastRatio(shades.at(-1)!, CARD[theme])).toBeGreaterThan(2.3);
    }
  });
});

describe("the geometry, at the width the window can actually be", () => {
  it("is the heatmap grid's width, which does not shrink", () => {
    // 53 columns × (11px block + 3px margin) − the trailing margin. The strip
    // is deliberately the same 739px, so it reads as the same window on the
    // same data — and a wider window buys it nothing, because the grid above it
    // does not grow either.
    expect(HEATMAP_GRID_W).toBe(739);
    const app = read("src/renderer/App.tsx");
    expect(app).toContain("blockSize={11}");
    expect(app).toContain("blockMargin={3}");
  });

  it("fits the card at the window's 880px minimum, gutter included", () => {
    // 880 − 64 (page px-8) − 40 (card px-5) = 776px of card. The strip is 739,
    // so it fits with 37px to spare at the narrowest the window can be — which
    // is the only width worth checking, since it is the one that fails.
    expect(WINDOW_SIZE.dashboard.minWidth).toBe(880);
    const card = WINDOW_SIZE.dashboard.minWidth - 64 - 40;
    expect(HEATMAP_GRID_W).toBeLessThan(card);
    // Those 37px are now a BUDGET, and the weekday gutter spends them: "Wed" at
    // 11px measures 25px, +8px of `LABEL_MARGIN`, so the strip starts 33px in
    // and clears the card's right edge by four. jsdom cannot measure text,
    // so this pins the budget rather than the spend — if the card ever gets
    // narrower, or the grid wider, the strip starts scrolling sideways at the
    // minimum window and this is the assertion that says so first.
    expect(card - HEATMAP_GRID_W).toBe(37);
  });

  it("leaves each bar room for a printed value, which 53 weeks would not", () => {
    // The measurement that chose sixteen: `44.1` set at 11px is 24.31px wide.
    // 53 weeks is a 14px pitch and the values collide; 16 gives 46.19px.
    expect(WEEK_PITCH).toBeCloseTo(46.19, 2);
    expect(WEEK_PITCH).toBe(HEATMAP_GRID_W / WEEKS);
    expect(WEEK_PITCH).toBeGreaterThan(24.31 * 1.5);
    expect(HEATMAP_GRID_W / 53).toBeLessThan(24.31);
  });

  it("scrolls inside the heatmap card rather than widening the page", async () => {
    // Same wrapper as the calendar. Content that overflowed the page BODY
    // instead of this box is the "why is it so squishy" failure `npm run smoke`
    // measures at 880px.
    const c = await mount(metricsBundle());
    const scroller = strip(c).parentElement;
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(scroller?.querySelector(".react-activity-calendar")).not.toBeNull();
    expect(strip(c).closest('[data-slot="heatmap"]')).not.toBeNull();
    expect(strip(c).style.width).toBe(`${String(HEATMAP_GRID_W)}px`);
  });

  it("raises its own ceiling rather than clipping a very long week flat", async () => {
    // A fixed 46h ceiling would draw a 46h week and a 62h week at the same
    // height, two rows above two different printed numbers.
    const c = await mount(bundleWith([46, 62]));
    const [normal, long] = part(c, "bar");
    expect(Number.parseFloat(long!.style.height)).toBeGreaterThan(
      Number.parseFloat(normal!.style.height),
    );
    expect(Number.parseFloat(long!.style.height)).toBeLessThanOrEqual(34);
  });
});

describe("the first bar and the heatmap's first column", () => {
  /** The `<svg>` the calendar draws its grid into. Column zero is its x = 0. */
  const grid = (c: HTMLElement): HTMLElement => {
    const el = c.querySelector<HTMLElement>(".react-activity-calendar__calendar");
    if (el === null) throw new Error("no calendar svg rendered");
    return el;
  };

  it("start in the same place, gutter and all", async () => {
    // `<ActivityCalendar>` renders "Mon / Wed / Fri" to the LEFT of its svg and
    // pushes the svg right by their measured width + 8. Everything it draws is
    // therefore inset by that much, and a sibling starting at 0 is inset by
    // nothing. Measured on this Mac, the difference is 33px — small enough to
    // have shipped unnoticed while the bars were pinned to the right edge, and
    // the first thing anyone sees now that they start at the left.
    const c = await mount(TWO_WEEKS);

    // Both numbers are COMPUTED — the calendar's by the library, the strip's by
    // `lib/heatmap-gutter.ts` re-deriving the same arithmetic without reaching
    // into the calendar's DOM. jsdom's `getBBox` stub reports a zero-width
    // label, so both come out at the bare `LABEL_MARGIN`; what is pinned here
    // is that they are the SAME expression, which is what rots when the library
    // changes its gutter.
    expect(strip(c).style.marginLeft).toBe(grid(c).style.marginLeft);
    expect(strip(c).style.marginLeft).not.toBe("");
    expect(strip(c).style.marginLeft).not.toBe("0px");
  });

  it("stay together when the calendar reserves no gutter at all", async () => {
    // `measureWeekdayGutter([])` is the `shouldShow === false` branch: no
    // labels, no gutter, and a strip that must NOT invent an 8px indent of its
    // own. Pure, so it needs no calendar to assert against.
    expect(measureWeekdayGutter([], 11)).toBe(0);
    // With labels there is always at least the 8px margin between them and the
    // grid, whatever the font measures.
    expect(measureWeekdayGutter(["mon", "wed", "fri"], 11)).toBeGreaterThanOrEqual(8);
  });
});
