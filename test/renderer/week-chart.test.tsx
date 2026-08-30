// @vitest-environment jsdom
/**
 * "This week", stacked per machine.
 *
 * Two things are being defended here and they fail in opposite directions.
 *
 *  1. **The stack must not out-grow its bar.** That half is arithmetic and it
 *     lives in main — `src/main/metrics.test.ts` pins it against the union
 *     query. What is checked here is that the renderer draws the split it was
 *     GIVEN and never re-derives one from `byMachine`, whose per-machine totals
 *     double-count an hour two Macs were both awake for.
 *
 *  2. **The greys have to be readable.** A monochrome palette is one careless
 *     stop away from a bar you cannot see, and there is no error when that
 *     happens — the chart renders, the numbers are right, and the owner simply
 *     cannot tell his two Macs apart. So the shades are asserted as CONTRAST
 *     RATIOS against the real card background in both themes, read out of
 *     `index.css`, rather than as hex strings that would pass just as happily
 *     on an unreadable palette.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import { contrastRatio, machineShades, type Ramp } from "@/renderer/lib/machine-shades";
import type { MachineBreakdown, MetricsBundle } from "@/shared/ipc-types";
import {
  cardByLabel,
  cardValue,
  defaultHandlers,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  renderApp,
  weekBars,
  type BarMachine,
} from "./harness";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

/** The ramp `App.tsx` owns, and the card it is drawn on. Both read from source
 *  so a palette edit has to come here and say what it did. */
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

function rampFromApp(theme: "light" | "dark"): Ramp {
  const m = new RegExp(`${theme}: \\[([^\\]]+)\\]`).exec(read("src/renderer/App.tsx"));
  if (!m) throw new Error(`no ${theme} ramp in App.tsx`);
  const stops = m[1]!.split(",").map((s) => s.trim().replace(/"/g, ""));
  expect(stops).toHaveLength(5);
  return stops as unknown as Ramp;
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

function machine(over: Partial<MachineBreakdown>): MachineBreakdown {
  return {
    machineId: "m",
    label: "a Mac",
    hours: 1,
    intervals: 1,
    meetingHours: 0,
    jigglerHours: 0,
    share: 1,
    lastSeenMs: null,
    ...over,
  };
}

/** A bundle whose bars and breakdown describe the same set of machines. */
function bundleFor(macs: readonly BarMachine[], hours: readonly number[]): MetricsBundle {
  return metricsBundle({
    weekBars: weekBars("2026-08-17", hours, macs),
    byMachine: macs.map((m) =>
      machine({ machineId: m.machineId, label: m.label, hours: m.weight, share: 1 / macs.length }),
    ),
  });
}

async function mount(
  bundle: MetricsBundle,
  theme: "light" | "dark" = "light",
): Promise<HTMLElement> {
  installBridge(makeBridge(defaultHandlers(bundle)));
  const { container } = renderApp(<App />, theme);
  await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));
  return container;
}

const legend = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[data-slot="week-legend-item"]')].map((el) => el.textContent ?? "");

/** The `--color-m0: …` declarations shadcn injects, per theme. */
function chartVars(c: HTMLElement, theme: "light" | "dark"): Record<string, string> {
  const style = [...c.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  // Light is the bare rule; dark is the one scoped by `.dark`.
  const blocks = [...style.matchAll(/(\.dark\s+)?\[data-chart=[^\]]+\]\s*\{([^}]*)\}/g)];
  const want = blocks.find((b) => (theme === "dark") === (b[1] !== undefined));
  const out: Record<string, string> = {};
  for (const d of (want?.[2] ?? "").matchAll(/--color-(\w+):\s*([^;]+);/g)) {
    out[d[1]!] = d[2]!.trim();
  }
  return out;
}

const ONE: BarMachine[] = [{ machineId: "solo", label: "Work laptop", weight: 1 }];
const THREE: BarMachine[] = [
  { machineId: "a", label: "Work laptop", weight: 4 },
  { machineId: "b", label: "Home iMac", weight: 2 },
  { machineId: "c", label: "Mac mini", weight: 1 },
];
const HOURS = [7.8, 8.6, 6.1, 9.2, 4.3, 0, 0.5];

describe("the greys", () => {
  it("are the heatmap's ramp, not a second grey scale", () => {
    // One vocabulary on the page. The bars take stops 4→1, strongest first;
    // stop 0 is the card and is deliberately never used.
    expect(machineShades(4, RAMP.light)).toEqual([
      RAMP.light[4],
      RAMP.light[3],
      RAMP.light[2],
      RAMP.light[1],
    ]);
    expect(machineShades(4, RAMP.dark)).toEqual([
      RAMP.dark[4],
      RAMP.dark[3],
      RAMP.dark[2],
      RAMP.dark[1],
    ]);
    for (const theme of ["light", "dark"] as const) {
      expect(machineShades(9, RAMP[theme])).not.toContain(RAMP[theme][0]);
    }
  });

  it("never blends into the card, in either theme, for one machine or four", () => {
    for (const theme of ["light", "dark"] as const) {
      // The stop that IS the background, so the threshold below is not an
      // arbitrary number: it is "clear of the thing that fails".
      expect(contrastRatio(RAMP[theme][0], CARD[theme])).toBeLessThan(1.15);

      for (let n = 1; n <= 4; n++) {
        for (const shade of machineShades(n, RAMP[theme])) {
          expect(contrastRatio(shade, CARD[theme])).toBeGreaterThan(1.4);
        }
      }
      // One, two or three Macs — the realistic cases — only ever reach the
      // three stops that are comfortably legible.
      for (let n = 1; n <= 3; n++) {
        for (const shade of machineShades(n, RAMP[theme])) {
          expect(contrastRatio(shade, CARD[theme])).toBeGreaterThan(2.3);
        }
      }
    }
  });

  it("are distinct from each other where two segments touch", () => {
    for (const theme of ["light", "dark"] as const) {
      for (let n = 2; n <= 4; n++) {
        const shades = machineShades(n, RAMP[theme]);
        expect(new Set(shades).size).toBe(n);
        for (let i = 1; i < shades.length; i++) {
          // 1.6 is the ramp's weakest adjacent step (light #A8A49C ↔ #D3D1CB),
          // reached only by a fourth machine — and the segments are also
          // separated by a card-coloured hairline, which is what makes a
          // boundary this soft still a boundary.
          expect(contrastRatio(shades[i - 1]!, shades[i]!)).toBeGreaterThan(1.6);
        }
      }
      // One, two or three Macs — the cases that actually happen — get steps
      // nobody has to squint at.
      for (let n = 2; n <= 3; n++) {
        const shades = machineShades(n, RAMP[theme]);
        for (let i = 1; i < shades.length; i++) {
          expect(contrastRatio(shades[i - 1]!, shades[i]!)).toBeGreaterThan(1.9);
        }
      }
    }
  });

  it("separates touching segments with the card colour, not with nothing", () => {
    // Belt and braces for the softest boundary. Card-coloured, so it is
    // invisible everywhere except exactly where two segments meet.
    const app = read("src/renderer/App.tsx");
    expect(app).toContain('stroke={series.length === 1 ? undefined : "var(--card)"}');
  });

  it("degrades to distinct shades rather than repeating one, past four machines", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const n of [5, 6, 8]) {
        const shades = machineShades(n, RAMP[theme]);
        expect(shades).toHaveLength(n);
        // A repeated grey is two machines with one swatch in the legend, which
        // is the single thing the legend exists to prevent.
        expect(new Set(shades).size).toBe(n);
        for (const shade of shades) {
          expect(contrastRatio(shade, CARD[theme])).toBeGreaterThan(1.4);
        }
      }
    }
  });

  it("has nothing to paint when no machine recorded anything", () => {
    expect(machineShades(0, RAMP.light)).toEqual([]);
  });
});

describe("the chart", () => {
  it("gives every machine its own shade, declared for BOTH themes", async () => {
    // The heatmap needs `colorScheme={resolvedTheme}` because the app follows a
    // class and the component reads the media query. The bars have the same
    // hazard and the same fix: declare both, let `.dark` win.
    const container = await mount(bundleFor(THREE, HOURS));

    const light = chartVars(container, "light");
    const dark = chartVars(container, "dark");
    expect([light["m0"], light["m1"], light["m2"]]).toEqual(machineShades(3, RAMP.light));
    expect([dark["m0"], dark["m1"], dark["m2"]]).toEqual(machineShades(3, RAMP.dark));

    for (const theme of ["light", "dark"] as const) {
      const vars = theme === "light" ? light : dark;
      for (const key of ["m0", "m1", "m2"]) {
        expect(contrastRatio(vars[key]!, CARD[theme])).toBeGreaterThan(2.3);
      }
    }
  });

  it("names the machines, so a shade can be read back to a Mac", async () => {
    const container = await mount(bundleFor(THREE, HOURS));
    expect(legend(container)).toEqual(["Work laptop", "Home iMac", "Mac mini"]);
    expect(container.querySelectorAll('[data-slot="week-legend-swatch"]')).toHaveLength(3);
  });

  it("PAINTS the legend swatches, in the theme on screen", async () => {
    // MEASURED, AND IT WAS WRONG. `var(--color-m0)` on the swatch resolved to
    // nothing: shadcn scopes `--color-<key>` to `[data-chart=…]` and the legend
    // is outside it, so at 880px in a real window the three swatches came back
    // `rgba(0, 0, 0, 0)` — three invisible squares beside three machine names,
    // with nothing throwing. The legend resolves its own hex now.
    const container = await mount(bundleFor(THREE, HOURS));
    const swatches = [...container.querySelectorAll('[data-slot="week-legend-swatch"]')];
    expect(swatches.map((el) => el.getAttribute("data-shade"))).toEqual(
      machineShades(3, RAMP.light),
    );
    for (const el of swatches) {
      const bg = (el as HTMLElement).style.backgroundColor;
      expect(bg).not.toBe("");
      expect(bg).not.toContain("var(");
    }
    // …and it follows the class the app toggles, not `prefers-color-scheme`.
    // Press `d` while macOS is light and the legend must move with the page.
    const dark = await mount(bundleFor(THREE, HOURS), "dark");
    expect(
      [...dark.querySelectorAll('[data-slot="week-legend-swatch"]')].map((el) =>
        el.getAttribute("data-shade"),
      ),
    ).toEqual(machineShades(3, RAMP.dark));
    for (const el of dark.querySelectorAll('[data-slot="week-legend-swatch"]')) {
      expect((el as HTMLElement).style.backgroundColor).not.toBe("");
      expect(contrastRatio(el.getAttribute("data-shade") ?? "", CARD.dark)).toBeGreaterThan(2.3);
    }
  });

  it("says out loud that overlap counts once, whenever there is more than one Mac", async () => {
    // Without it the stack reads as a sum, and a Mac that only ever worked
    // inside the other one's session reads as a Mac that did nothing.
    const many = await mount(bundleFor(THREE, HOURS));
    expect(many.querySelector('[data-slot="week-union-note"]')?.textContent).toContain(
      "counts once",
    );
  });

  it("does not look broken with ONE machine, which is today's reality", async () => {
    const container = await mount(bundleFor(ONE, HOURS));
    expect(legend(container)).toEqual(["Work laptop"]);
    // One machine, one shade — the strongest, which is the solid bar this
    // dashboard has always drawn.
    expect(chartVars(container, "light")["m0"]).toBe(RAMP.light[4]);
    expect(chartVars(container, "dark")["m0"]).toBe(RAMP.dark[4]);
    // …and no sentence about overlap, because there is nothing to overlap.
    expect(container.querySelector('[data-slot="week-union-note"]')).toBeNull();
  });

  it("has nothing to stack, and no legend, when no machine has recorded anything", async () => {
    // First run. The bar the dashboard has always drawn is still there — see
    // the `series.length === 0` branch — but there is no machine to name.
    const container = await mount(
      metricsBundle({ weekBars: weekBars("2026-08-17", HOURS, []), byMachine: [] }),
    );
    expect(legend(container)).toEqual([]);
    expect(container.querySelector('[data-slot="week-legend"]')).toBeNull();
    expect(container.querySelector('[data-slot="week-union-note"]')).toBeNull();
    expect(chartVars(container, "light")["m0"]).toBeUndefined();
  });

  it("takes its series from the BARS, never from the per-machine breakdown", async () => {
    // THE BUG THIS REPLACES. `byMachine.hours` are per-machine TOTALS and they
    // double-count an hour two Macs were both awake for; `WeekBar.machines` is
    // the union split and comes to the bar. Here the breakdown deliberately
    // disagrees — different ids, different labels, forty hours apiece — and the
    // chart has to follow the bars.
    const macs: BarMachine[] = [
      { machineId: "bar-a", label: "Work laptop", weight: 3 },
      { machineId: "bar-b", label: "Home iMac", weight: 1 },
    ];
    const bundle = metricsBundle({
      weekBars: weekBars("2026-08-17", HOURS, macs),
      byMachine: [
        machine({ machineId: "other-1", label: "NOT THIS ONE", hours: 40 }),
        machine({ machineId: "other-2", label: "NOR THIS", hours: 40 }),
        machine({ machineId: "other-3", label: "NOR THIS EITHER", hours: 40 }),
      ],
    });
    const mon = bundle.weekBars[0]!;
    expect(mon.machines.reduce((a, m) => a + m.hours, 0)).toBeCloseTo(mon.hours, 6);

    const container = await mount(bundle);
    expect(legend(container)).toEqual(["Work laptop", "Home iMac"]);
    // Two series, not three: the breakdown's third machine never appears.
    expect(Object.keys(chartVars(container, "light")).sort()).toEqual(["hours", "m0", "m1"]);
  });
});
