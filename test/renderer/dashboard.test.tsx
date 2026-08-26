// @vitest-environment jsdom
/**
 * The dashboard, against a stubbed bridge.
 *
 * Every number here arrives over `window.wwb.invoke`. `design/mock-data.reference.ts`
 * is not imported by anything that ships and is not imported here either — a
 * test that passes because the component still carries mock data would be
 * worse than no test at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import { WINDOW_SIZE } from "@/shared/constants";
import { DEFAULT_METRICS_POLICY, type MetricsBundle } from "@/shared/ipc-types";
import {
  cardByLabel,
  cardSub,
  cardValue,
  defaultHandlers,
  emptyMetricsBundle,
  heatmapDays,
  installBridge,
  installDomStubs,
  levelFor,
  liveStatus,
  makeBridge,
  metricsBundle,
  renderApp,
  skeletonOf,
  statCards,
} from "./harness";

/**
 * The four cards whose value comes out of the METRICS BUNDLE. "Today" is
 * deliberately not among them: its number is `hoursToday()` over `LiveStatus`,
 * which is what makes it the same figure the menu bar shows, and it therefore
 * survives a metrics query that fails.
 */
const LABELS = [
  "This week",
  "Avg interval · week",
  "Avg interval · all time",
  "Longest interval",
] as const;

/** All five, in the order they render. */
const ALL_LABELS = [
  "This week",
  "Today",
  "Avg interval · week",
  "Avg interval · all time",
  "Longest interval",
] as const;

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

describe("stat cards render the values the IPC client returned", () => {
  it("shows all four, from the bundle and not from mock data", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);

    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    // 36.5 h this week, 112 min average, 98 min all-time average, a 6.2 h
    // longest interval — every one of them from the stub above.
    expect(cardValue(cardByLabel(container, "Avg interval · week"))).toBe("1h 52m");
    expect(cardValue(cardByLabel(container, "Avg interval · all time"))).toBe("1h 38m");
    expect(cardValue(cardByLabel(container, "Longest interval"))).toBe("6h 12m");

    expect(cardSub(cardByLabel(container, "This week"))).toBe("+4.2h vs last week");
    expect(cardSub(cardByLabel(container, "Avg interval · week"))).toBe("20 intervals");
    expect(cardSub(cardByLabel(container, "Avg interval · all time"))).toBe("1,284 intervals");
    // "Mar 4, 2026", the way the mockup writes it — not the wire's ISO string,
    // and not March 3rd, which is what `new Date("2026-03-04")` renders in any
    // negative-offset zone.
    expect(cardSub(cardByLabel(container, "Longest interval"))).toBe("Mar 4, 2026 · Work laptop");

    // The machine breakdown and the idle timeout are IPC-fed too.
    expect(container.textContent).toContain("Home iMac");
    expect(container.textContent).toContain("15 min");
  });

  it("asks main for metrics with the default policy, and only over the bridge", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    const call = bridge.calls.find((c) => c.channel === "wwb:metrics:get");
    expect(call?.payload).toEqual(DEFAULT_METRICS_POLICY);
    // No channel outside the contract, and nothing invented locally.
    expect(new Set(bridge.calls.map((c) => c.channel))).toEqual(
      new Set([
        "wwb:app:info",
        "wwb:status:get",
        "wwb:metrics:get",
        "wwb:toggles:get",
        "wwb:settings:set",
      ]),
    );
  });

  it("renders a real zero as 0, not as an em-dash", async () => {
    const bridge = makeBridge(
      defaultHandlers(metricsBundle({ week: { hours: 0, prevHours: 0 } })),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("0.0"));
    expect(cardSub(cardByLabel(container, "This week"))).toBe("+0.0h vs last week");
  });
});

describe("Today — the card, and the number the menu bar is showing", () => {
  it("counts the OPEN interval, so it is the menu bar's figure and not the database's", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    // 5.1 closed hours today (`closedHoursToday`, and `metrics.today.hours`
    // carries the same 5.1) plus the open interval, credited to its last real
    // signal: 2h41m − 12s = 2.683h. 7.783 → 7.8.
    //
    // The database figure alone would render "5.1", which is what the tray
    // title would then be contradicting by 2.7 hours. That is the whole reason
    // this card is built on `hoursToday()` and not on `metrics.today.hours`.
    expect(cardValue(cardByLabel(container, "Today"))).toBe("7.8");
    expect(cardValue(cardByLabel(container, "Today"))).not.toBe("5.1");
  });

  it("shows the same string the stopwatch card shows, six inches down the page", async () => {
    // Two "today" figures in one window. They are the same call on the same
    // snapshot — this asserts they stay that way.
    const bridge = makeBridge(
      defaultHandlers(
        metricsBundle({ today: { date: "2026-08-19", hours: 1.25, prevHours: 4.3 } }),
        liveStatus({ closedHoursToday: 1.25 }),
      ),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    const card = cardValue(cardByLabel(container, "Today"));
    const stopwatch = container.querySelector('[data-slot="stopwatch-today"]');
    expect(card).toBe("3.9");
    expect(stopwatch?.textContent).toContain(card);
  });

  it("compares itself against yesterday, the way This week compares against last week", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    // 7.8 today against 4.3 yesterday. The LIVE figure is the left-hand side,
    // or the sub-line would be contradicting the number directly above it.
    expect(cardSub(cardByLabel(container, "Today"))).toBe("+3.5h vs yesterday");
    expect(cardSub(cardByLabel(container, "This week"))).toBe("+4.2h vs last week");
  });

  it("has no yesterday to compare against on the first day, and says nothing", async () => {
    const bridge = makeBridge(
      defaultHandlers(metricsBundle({ today: { date: "2026-08-19", hours: 5.1, prevHours: null } })),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "Today"))).toBe("7.8"));
    // A non-breaking space, not a "+7.8h vs yesterday" invented out of a null.
    expect(cardSub(cardByLabel(container, "Today")).trim()).toBe("");
  });

  it("wears the same ⚠︎ as This week when the keyboard bits are missing", async () => {
    // An hours figure that is silently low is the failure this app is built
    // against, and Today is as exposed to it as the week is.
    const bridge = makeBridge(
      defaultHandlers(metricsBundle(), liveStatus({ degraded: ["keyboard_permission_missing"] })),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "Today"))).toBe("7.8"));
    expect(cardByLabel(container, "Today").textContent).toContain("⚠︎");
  });
});

describe("the stat row tiles with no orphan, at every width the window can be", () => {
  /** Tailwind's breakpoint minimums. A prefix applies at and above its width. */
  const BREAKPOINTS: Record<string, number> = {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    "2xl": 1536,
  };

  /**
   * The value of `pattern` in effect at `width`: the bare class, overridden by
   * the largest breakpoint prefix the width has reached. Exactly what the
   * cascade does, because the utilities are emitted in breakpoint order.
   */
  function resolve(className: string, pattern: string, width: number): number | null {
    let best: number | null = null;
    let bestAt = -1;
    for (const cls of className.split(/\s+/)) {
      const m = /^(?:([a-z0-9]+):)?(.+)-(\d+)$/.exec(cls);
      if (!m || m[2] !== pattern) continue;
      const at = m[1] === undefined ? 0 : (BREAKPOINTS[m[1]] ?? Infinity);
      if (at <= width && at >= bestAt) {
        bestAt = at;
        best = Number(m[3]);
      }
    }
    return best;
  }

  /**
   * Walk the cards the way CSS grid auto-placement does — row-major, no
   * back-filling — and report every hole. A card that does not fit in what is
   * left of a row moves to the next one and STRANDS those columns; a last row
   * that ends short strands its own. Both read as one card adrift, which is
   * exactly what five cards in a four-column grid look like.
   */
  function holes(cols: number, spans: number[]): string[] {
    const out: string[] = [];
    let cursor = 0;
    spans.forEach((span, i) => {
      if (span > cols) out.push(`card ${i} spans ${span} of ${cols} columns`);
      if (cursor + span > cols) {
        out.push(`card ${i} leaves ${cols - cursor} empty columns behind it`);
        cursor = 0;
      }
      cursor = (cursor + span) % cols;
    });
    if (cursor !== 0) out.push(`the last row ends ${cols - cursor} columns short`);
    return out;
  }

  it("fills every row at the minimum width, the default width and wider", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(statCards(container)).toHaveLength(5));

    const row = container.querySelector('[data-slot="stat-row"]');
    expect(row).not.toBeNull();
    const rowClass = (row as Element).className;
    const cardClasses = statCards(container).map((c) => c.className);

    // 880 is the window's own minimum, 1100 is where it opens, and 1600 is a
    // large display. Below `sm` the grid is one column, which five cards fill
    // perfectly by definition.
    for (const width of [WINDOW_SIZE.dashboard.minWidth, WINDOW_SIZE.dashboard.width, 1600]) {
      const cols = resolve(rowClass, "grid-cols", width);
      expect(cols, `no grid-cols in effect at ${width}px`).not.toBeNull();
      const spans = cardClasses.map((c) => resolve(c, "col-span", width) ?? 1);
      expect(holes(cols as number, spans), `at ${width}px`).toEqual([]);
    }
  });

  it("switches to the multi-column shape BELOW the window's minimum width", async () => {
    // The trap this exists for: `lg:` is 1024px and the dashboard's minimum is
    // 880px, so an `lg:` grid quietly falls back to the `sm:` one for every
    // window between 880 and 1023 — the range nobody screenshots. Whatever
    // breakpoint the row uses has to have taken effect by 880.
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(statCards(container)).toHaveLength(5));

    const rowClass = (container.querySelector('[data-slot="stat-row"]') as Element).className;
    expect(resolve(rowClass, "grid-cols", WINDOW_SIZE.dashboard.minWidth)).toBeGreaterThan(1);
  });

  it("gives the two totals the top row and the three interval figures the second", async () => {
    // Not decoration: five is prime, so the only equal-column grids that leave
    // no orphan are one column and five, and five columns at 880px gives each
    // card 122px of content. The 3+3 / 2+2+2 split is what buys the room, and
    // it is also the meaning — "how much have I worked" over "what shape are
    // my sessions".
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(statCards(container)).toHaveLength(5));

    const labels = statCards(container).map((c) => c.firstElementChild?.textContent);
    expect(labels).toEqual([...ALL_LABELS]);

    const width = WINDOW_SIZE.dashboard.minWidth;
    const spans = statCards(container).map((c) => resolve(c.className, "col-span", width) ?? 1);
    expect(spans).toEqual([3, 3, 2, 2, 2]);
  });
});

describe("the order of the blocks down the page", () => {
  /** The `data-slot` markers that name a block, in the order they render. */
  const BLOCKS = ["title-bar", "alert-banner", "status-strip", "stat-row", "stopwatch", "heatmap"];

  function blockOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-slot]"))
      .map((el) => el.getAttribute("data-slot") ?? "")
      .filter((slot) => BLOCKS.includes(slot));
  }

  it("puts the tracked figures above the timer, and the timer above the heatmap", async () => {
    // The owner's words: "the server laptop counted 4 minutes, last signal 19
    // seconds ago, the jiggler and keep awake — that should be above the
    // timer", and "the timer should be below all those metric tracked blocks
    // as well, above the GitHub graph thing".
    //
    // The stopwatch was the first card on the page. What is true RIGHT NOW
    // (which Mac, last signal, the two switches — the "counted" figure has
    // since gone, see "the status strip" below) and the week's totals now
    // come first, and the live session sits between them and the
    // heatmap. This is asserted rather than merely done, because an order
    // nothing checks is an order that drifts back to whatever reads best in
    // the source file.
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    expect(blockOrder(container)).toEqual([
      "title-bar",
      "status-strip",
      "stat-row",
      "stopwatch",
      "heatmap",
    ]);
  });

  it("keeps the degraded banner above everything it is warning about", async () => {
    // A banner under the numbers it disowns is a banner nobody reads.
    const bridge = makeBridge(
      defaultHandlers(metricsBundle(), liveStatus({ degraded: ["keyboard_permission_missing"] })),
    );
    installBridge(bridge);

    const { container, findByRole } = renderApp(<App />);
    await findByRole("alert");

    expect(blockOrder(container)).toEqual([
      "title-bar",
      "alert-banner",
      "status-strip",
      "stat-row",
      "stopwatch",
      "heatmap",
    ]);
  });
});

describe("tabular-nums", () => {
  it("is on every number that changes on a timer or on data arrival", async () => {
    // Without it the layout jitters once a second, which is the sort of thing
    // that reads as "the app is broken" long before anyone works out why.
    const asOf = Date.parse("2026-08-19T14:41:00-05:00");
    vi.spyOn(Date, "now").mockReturnValue(asOf);
    const bridge = makeBridge(
      defaultHandlers(
        metricsBundle(),
        // 4 minutes rather than 12 seconds: the last-signal cell rounds to the
        // minute now, and '12s' would land on 'just now' — a string with no
        // digits in it, which cannot demonstrate anything about tabular-nums.
        liveStatus({ lastSignalMs: asOf - 240_000, openedAtMs: asOf - 240_000 - 9_660_000 }),
      ),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    for (const card of statCards(container)) {
      expect(card.children[1]?.firstElementChild?.className).toContain("tabular-nums");
    }

    const spanWith = (text: string): Element => {
      const el = [...container.querySelectorAll("span")].find((s) => s.textContent === text);
      if (!el) throw new Error(`no span reading "${text}"`);
      return el;
    };
    // The last-signal cell reads '4m ago' rather than '12s ago': it settles to
    // the minute and no longer ticks at all. `last-signal.test.tsx` owns that
    // behaviour; this line only checks it kept the class.
    expect(spanWith("4m ago").className).toContain("tabular-nums");
    expect(spanWith("24.5h").className).toContain("tabular-nums"); // per machine
    expect(spanWith("2,614 h tracked since Aug 2025").className).toContain("tabular-nums");
    expect(spanWith("15 min").className).toContain("tabular-nums"); // idle timeout
    vi.restoreAllMocks();
  });
});

describe("the first-run empty state", () => {
  it("renders every card at full size with an em-dash", async () => {
    // A first-run STATUS as well as a first-run bundle: "Today" is the one
    // card that reads `LiveStatus`, so a fixture that left 5.1 closed hours on
    // it would be describing a machine whose database is simultaneously empty
    // and not.
    const bridge = makeBridge(
      defaultHandlers(
        emptyMetricsBundle(),
        liveStatus({
          state: "idle",
          openedAtMs: null,
          lastSignalMs: null,
          closedHoursThisWeek: null,
          closedHoursToday: null,
        }),
      ),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);

    await waitFor(() => expect(statCards(container)).toHaveLength(5));
    for (const label of ALL_LABELS) {
      const card = cardByLabel(container, label);
      expect(cardValue(card)).toBe("—");
      // The sub line always renders — a non-breaking space when empty — so the
      // card keeps its height.
      expect(cardSub(card).length).toBeGreaterThan(0);
    }
  });

  it("does not reflow the grid when the data arrives", async () => {
    const emptyBridge = makeBridge(defaultHandlers(emptyMetricsBundle()));
    installBridge(emptyBridge);
    const empty = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(empty.container, "This week"))).toBe("—"));
    const emptyRow = empty.container.querySelector('[data-slot="stat-row"]');

    const fullBridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(fullBridge);
    const full = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(full.container, "This week"))).toBe("36.5"));
    const fullRow = full.container.querySelector('[data-slot="stat-row"]');

    // Same elements, same classes, different text only. Nothing appears or
    // disappears between the two states, so nothing can move. PRD §4.
    expect(emptyRow).not.toBeNull();
    expect(fullRow).not.toBeNull();
    expect(skeletonOf(emptyRow as Element)).toBe(skeletonOf(fullRow as Element));
  });

  it("survives a bundle with no heatmap rows at all", async () => {
    // ActivityCalendar THROWS on an empty array. A first-run database returns
    // exactly that, so this is the difference between an empty dashboard and a
    // white window.
    const bridge = makeBridge(defaultHandlers(emptyMetricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("—"));

    // The page is still standing, and the calendar went into its own full-size
    // loading skeleton — which is what injects this keyframes block — rather
    // than taking the tree down.
    expect(container.textContent).toContain("Daily hours");
    const injected = Array.from(document.head.querySelectorAll("style"))
      .map((s) => s.innerHTML)
      .join("");
    expect(injected).toContain("react-activity-calendar--loading-animation");
  });
});

describe("the heatmap", () => {
  /** One entry per day for 371 days, with a hand-chosen hours value per day. */
  function bundleWithHeatmap(): MetricsBundle {
    const days = heatmapDays("2025-08-18", 371, (i, date) => {
      if (date === "2025-08-20") return 0; // a day off
      if (date === "2025-08-21") return 1.2; // a short day is NOT a day off
      if (date === "2025-08-22") return 4.9;
      if (date === "2025-08-23") return 6.5;
      if (date === "2025-08-24") return 9.4;
      return i % 7 >= 5 ? 0 : 7.25;
    });
    return metricsBundle({ heatmap: days });
  }

  it("receives one entry per day, and renders the level main sent", async () => {
    const bundle = bundleWithHeatmap();
    const bridge = makeBridge(defaultHandlers(bundle));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() =>
      expect(container.querySelectorAll("[data-date]").length).toBeGreaterThan(0),
    );

    const rendered = new Map<string, string>();
    for (const el of container.querySelectorAll("[data-date]")) {
      const date = el.getAttribute("data-date") ?? "";
      expect(rendered.has(date)).toBe(false); // one entry per day, never two
      rendered.set(date, el.getAttribute("data-level") ?? "");
    }

    const first = bundle.heatmap[0]!.date;
    const last = bundle.heatmap.at(-1)!.date;
    const inRange = [...rendered.keys()].filter((d) => d >= first && d <= last);
    expect(inRange).toHaveLength(371);

    for (const day of bundle.heatmap) {
      expect(rendered.get(day.date)).toBe(String(day.level));
    }

    // The levels themselves: thresholds [2, 5, 8], and a 1.2 h day must not
    // look like a day off (docs/IMPL_UI.md §5.8).
    expect(rendered.get("2025-08-20")).toBe("0");
    expect(rendered.get("2025-08-21")).toBe("1");
    expect(rendered.get("2025-08-22")).toBe("2");
    expect(rendered.get("2025-08-23")).toBe("3");
    expect(rendered.get("2025-08-24")).toBe("4");
    expect(levelFor(1.2)).toBe(1);
  });

  /** The colour a level-3 block is painted; the ramp is read off the DOM. */
  function level3Fill(container: HTMLElement): string | null | undefined {
    return container.querySelector('[data-level="3"]')?.getAttribute("fill");
  }

  it("takes its colour scheme from the app's class, not from prefers-color-scheme", async () => {
    // The component follows `prefers-color-scheme`; the app follows the class
    // ThemeProvider writes. The stub reports a light system. Without the
    // explicit colorScheme prop the two can disagree, and the heatmap alone
    // stays light while everything around it goes dark.
    const bridge = makeBridge(defaultHandlers(bundleWithHeatmap()));
    installBridge(bridge);

    const { container } = renderApp(<App />);

    // #6B6862 is the fourth stop of the LIGHT ramp. A 2-stop ramp would
    // interpolate to something else here, so this also pins the 5-stop ramp
    // that keeps a full-time year readable (design/README.md).
    await waitFor(() => expect(level3Fill(container)).toBe("#6B6862"));

    act(() => {
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
    });

    await waitFor(() => expect(level3Fill(container)).toBe("#8A8A8A"));
  });
});

describe("an IPC failure", () => {
  it("renders a visible error rather than blank or zeroed cards", async () => {
    const handlers = defaultHandlers(metricsBundle());
    const bridge = makeBridge({
      ...handlers,
      "wwb:metrics:get": () => {
        throw new Error("database is locked");
      },
    });
    installBridge(bridge);

    const { container, findByRole } = renderApp(<App />);

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("database is locked");
    expect(alert.textContent).toContain("Couldn’t read your data");

    // Not blank, and above all not zero: a zero here would be a lie about the
    // week, and the whole point of `number | null` on the wire.
    for (const label of LABELS) {
      expect(cardValue(cardByLabel(container, label))).toBe("—");
    }
    // …but Today is NOT em-dashed, because its number did not come from the
    // query that failed. `wwb:status:get` answered, and 5.1 closed hours plus
    // the open interval is still exactly what the menu bar is showing. Blanking
    // a figure we hold would be throwing away good data to look consistent.
    expect(cardValue(cardByLabel(container, "Today"))).toBe("7.8");
    expect(statCards(container)).toHaveLength(5);
  });

  it("retries every query when the banner's Retry is pressed", async () => {
    let fail = true;
    const handlers = defaultHandlers(metricsBundle());
    const bridge = makeBridge({
      ...handlers,
      "wwb:metrics:get": () => {
        if (fail) throw new Error("database is locked");
        return metricsBundle();
      },
    });
    installBridge(bridge);

    const { container, findByRole, queryByRole } = renderApp(<App />);
    const alert = await findByRole("alert");
    fail = false;

    const retry = alert.querySelector("button");
    expect(retry).not.toBeNull();
    act(() => {
      retry?.click();
    });

    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));
    expect(queryByRole("alert")).toBeNull();
  });

  it("says so when the preload never loaded, instead of rendering a white window", async () => {
    installBridge(undefined); // window.wwb is undefined — the CJS/ESM preload trap

    const { findByRole } = renderApp(<App />);
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("window.wwb is missing");
  });
});

describe("live status", () => {
  it("pulses once, and only while working", async () => {
    const asOf = Date.parse("2026-08-19T14:41:00-05:00");
    vi.spyOn(Date, "now").mockReturnValue(asOf);
    const status = liveStatus({
      lastSignalMs: asOf - 12_000,
      openedAtMs: asOf - 12_000 - 9_660_000, // 2h 41m before the last signal
    });
    const bridge = makeBridge(defaultHandlers(metricsBundle(), status));
    installBridge(bridge);

    const { container } = renderApp(<App />);

    // ONE pulsing dot, and it is the stopwatch's. The status strip used to
    // carry a second one six pixels below it, driven by a three-state
    // `status.state` rather than by the seven-state machine in
    // `shared/stopwatch.ts`. See "one live state, not two" below.
    await waitFor(() =>
      expect(container.querySelector('[data-slot="stopwatch-ping"]')).not.toBeNull(),
    );
    // The strip used to print `creditedOpenMs()` here, and this test used to
    // assert it was lastSignalMs − openedAtMs rather than nowMs − openedAtMs
    // (AGENTS.md, the rule that outranks everything). The readout was removed
    // as a duplicate of the stopwatch's own digits; that assertion did not go
    // with it. It lives in `stopwatch.test.tsx`, "credits the open interval to
    // the last real signal", where the gap is made big enough to actually tell
    // the two apart — which the 12 seconds here never could.
    // 12 seconds since the last signal now reads 'just now', not '12s': the
    // strip settled to minute resolution so the stopwatch above is the only
    // thing on the page that moves. `last-signal.test.tsx` owns that.
    expect(container.textContent).toContain("last signal just now");
    vi.restoreAllMocks();
  });

  it("does not pulse when idle", async () => {
    const bridge = makeBridge(
      defaultHandlers(metricsBundle(), liveStatus({ state: "idle", openedAtMs: null })),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(container.textContent).toContain("Idle"));
    expect(container.querySelector('[data-slot="stopwatch-ping"]')).toBeNull();
    // Nothing else on the page may grow one either.
    expect(container.querySelectorAll(".animate-ping")).toHaveLength(0);
  });

  it("says the live state ONCE, and says it with the richer state machine", async () => {
    // The stopwatch and the older status strip each rendered a pulsing dot and
    // the word "Working", one above the other, and they could disagree: the
    // strip read `status.state` and knew three states, while the stopwatch runs
    // `stopwatchView()` and distinguishes running from held, capped, uncounted,
    // degraded, paused and idle. Two answers to one question, and the shallower
    // one had equal billing.
    const bridge = makeBridge(defaultHandlers(metricsBundle(), liveStatus()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() =>
      expect(container.querySelector('[data-slot="stopwatch-label"]')?.textContent).toBe("Working"),
    );

    const occurrences = (container.textContent ?? "").match(/Working/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(container.querySelectorAll(".animate-ping")).toHaveLength(1);
  });

  it("keeps the richer state when the shallower one would have said 'Working'", async () => {
    // `status.state` is "working" here — the strip would have said so. The
    // stopwatch knows the jiggler is on and that this time will not be counted,
    // which is the whole reason it is the survivor.
    const bridge = makeBridge(
      defaultHandlers(metricsBundle(), liveStatus({ jigglerOnForOpenInterval: true })),
    );
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() =>
      expect(container.querySelector('[data-slot="stopwatch-label"]')?.textContent).toBe(
        "Not counted",
      ),
    );
    expect(container.textContent).not.toContain("Working");
    // …and no confident pulse over a number that is being discarded on purpose.
    expect(container.querySelectorAll(".animate-ping")).toHaveLength(0);
  });

  it("shows a degraded permission as words, and marks the number it spoils", async () => {
    const bridge = makeBridge(
      defaultHandlers(
        metricsBundle(),
        liveStatus({ degraded: ["keyboard_permission_missing"] }),
      ),
    );
    installBridge(bridge);

    const { container, findAllByRole } = renderApp(<App />);
    const alerts = await findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("typing is invisible");

    await waitFor(() =>
      expect(cardByLabel(container, "This week").textContent).toContain("⚠︎"),
    );
  });
});

describe("the status strip", () => {
  /** The strip's own direct children, named by `data-slot` or by tag. */
  function stripParts(container: HTMLElement): string[] {
    const strip = container.querySelector('[data-slot="status-strip"]');
    if (!strip) throw new Error("no status strip");
    return [...strip.children].map(
      (el) => el.getAttribute("data-slot") ?? el.tagName.toLowerCase(),
    );
  }

  it("does not print the counted figure a second time", async () => {
    // The owner's words: "in the top bar where the jiggler and keep awake
    // toggles are, can you remove the 'counted ten minutes' — I can already
    // see the amount of time that's counted in the timer, I don't need to see
    // it again up there."
    const bridge = makeBridge(defaultHandlers(metricsBundle(), liveStatus()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    const strip = container.querySelector('[data-slot="status-strip"]')!;
    expect(strip.querySelector('[data-slot="credited-open"]')).toBeNull();
    expect(strip.textContent).not.toContain("counted");
    // The stopwatch still shows the session — this is a removed duplicate, not
    // a removed number. `stopwatch.test.tsx` owns what that figure is worth.
    expect(container.querySelector('[data-slot="stopwatch-digits"]')).not.toBeNull();
  });

  it("has no doubled and no dangling separator", async () => {
    // Deleting a cell out of a divider-separated row is how the row ends up
    // with two rules side by side, or one hanging off the end. Nothing about
    // that throws, and at 13px nobody files it — the app just looks broken.
    const bridge = makeBridge(defaultHandlers(metricsBundle(), liveStatus()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    const parts = stripParts(container);
    expect(parts.at(0)).not.toBe("separator");
    expect(parts.at(-1)).not.toBe("separator");
    expect(parts.some((x, i) => x === "separator" && parts[i + 1] === "separator")).toBe(false);
    // machine, one rule, last signal, then the toggles.
    expect(parts.filter((x) => x === "separator").length).toBe(1);
  });
});

describe("push subscriptions", () => {
  it("re-reads metrics exactly once per metrics-stale push", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));
    const before = bridge.calls.filter((c) => c.channel === "wwb:metrics:get").length;

    act(() => bridge.emit("wwb:push:metrics-stale", { reason: "interval-close" }));

    await waitFor(() =>
      expect(bridge.calls.filter((c) => c.channel === "wwb:metrics:get")).toHaveLength(before + 1),
    );
  });

  it("takes a whole status snapshot from a push, and unsubscribes on unmount", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container, unmount } = renderApp(<App />);
    await waitFor(() => expect(container.textContent).toContain("Work laptop"));
    expect(bridge.listenerCount("wwb:push:status")).toBe(1);

    act(() => bridge.emit("wwb:push:status", liveStatus({ machineLabel: "Home iMac" })));
    await waitFor(() => expect(container.textContent).toContain("Home iMac"));

    unmount();
    expect(bridge.listenerCount("wwb:push:status")).toBe(0);
    expect(bridge.listenerCount("wwb:push:toggles")).toBe(0);
    expect(bridge.listenerCount("wwb:push:metrics-stale")).toBe(0);
  });
});

describe("toggles", () => {
  it("sends the dashboard's toggle over IPC and takes main's answer as the truth", async () => {
    const bridge = makeBridge(defaultHandlers(metricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);
    const jiggler = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('[aria-label="Jiggler"]');
      if (!el) throw new Error("no jiggler switch");
      return el;
    });

    await waitFor(() => expect(jiggler.getAttribute("data-state")).toBe("unchecked"));
    act(() => jiggler.click());

    await waitFor(() => expect(jiggler.getAttribute("data-state")).toBe("checked"));
    expect(bridge.calls).toContainEqual({
      channel: "wwb:toggles:set",
      payload: { key: "jiggler", value: true, source: "dashboard" },
    });
  });

  it("disables the jiggler switch when main says it is unavailable", async () => {
    const handlers = defaultHandlers(metricsBundle());
    const bridge = makeBridge({
      ...handlers,
      "wwb:toggles:get": () => ({
        jiggler: false,
        keepAwake: false,
        paused: false,
        jigglerAvailable: false,
        jigglerUnavailableReason: "Accessibility is not granted",
      }),
    });
    installBridge(bridge);

    const { container } = renderApp(<App />);
    // Never a switch that appears live and does nothing (MACOS.md §6).
    await waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Jiggler"]')?.disabled,
      ).toBe(true),
    );
    expect(container.textContent).toContain("Jiggler");
  });
});
