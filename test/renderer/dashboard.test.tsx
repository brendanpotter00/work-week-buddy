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

const LABELS = [
  "This week",
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
    // (which Mac, counted, last signal, the two switches) and the week's
    // totals now come first, and the live session sits between them and the
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
        liveStatus({ lastSignalMs: asOf - 12_000, openedAtMs: asOf - 12_000 - 9_660_000 }),
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
    expect(spanWith("2h 41m").className).toContain("tabular-nums"); // the open interval
    expect(spanWith("12s").className).toContain("tabular-nums"); // last signal, ago
    expect(spanWith("24.5h").className).toContain("tabular-nums"); // per machine
    expect(spanWith("2,614 h tracked since Aug 2025").className).toContain("tabular-nums");
    expect(spanWith("15 min").className).toContain("tabular-nums"); // idle timeout
    vi.restoreAllMocks();
  });
});

describe("the first-run empty state", () => {
  it("renders every card at full size with an em-dash", async () => {
    const bridge = makeBridge(defaultHandlers(emptyMetricsBundle()));
    installBridge(bridge);

    const { container } = renderApp(<App />);

    await waitFor(() => expect(statCards(container)).toHaveLength(4));
    for (const label of LABELS) {
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
    expect(statCards(container)).toHaveLength(4);
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
  it("pulses only while working, and credits the open interval to the last signal", async () => {
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
    // lastSignalMs − openedAtMs = 2h 41m. NOT nowMs − openedAtMs, which would
    // be 2h 41m plus however long the countdown has been running. AGENTS.md,
    // the rule that outranks everything.
    expect(container.querySelector('[data-slot="credited-open"]')?.textContent).toBe("2h 41m");
    expect(container.textContent).toContain("2h 41m");
    expect(container.textContent).toContain("12s");
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
