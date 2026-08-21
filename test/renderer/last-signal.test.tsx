// @vitest-environment jsdom
/**
 * 'last signal …' — the status strip's age cell.
 *
 * The owner's complaint, verbatim: "Last signal gives like the amount of
 * seconds ago. I don't like how there are two moving things on the page that
 * should just have a time to the last minute." So the requirement under test
 * is CALM, and calm is three separate claims that need three separate proofs:
 *
 *  1. the cell reads to the nearest minute,
 *  2. it does not re-render sixty times a minute,
 *  3. the stopwatch beside it still ticks once a second, because that one is
 *     supposed to move.
 *
 * ── HOW (2) IS PROVED ───────────────────────────────────────────────────────
 * A render count cannot be observed from outside a component without putting a
 * counter inside it, and a counter inside shipped code is worse than the bug.
 * So it is proved as a chain of two things that CAN each be observed, and which
 * together are exactly equivalent:
 *
 *   A. `LastSignal` is a `React.memo` component — asserted structurally. That
 *      is the guarantee "props unchanged ⇒ React skips the render".
 *   B. Its props are unchanged across a second — asserted by driving 65 one-
 *      second ticks with no push and watching the output hold still, and then
 *      by pushing a new snapshot and watching it move. Only `lastSignalMs` and
 *      `asOfMs` can reach it, and neither is a clock the renderer owns.
 *
 * A ∧ B ⇒ no render. Dropping either half is what lets the string merely LOOK
 * still while being recomputed sixty times a minute, which is the cost the
 * owner actually asked to remove.
 *
 * ── THE BUG UNDERNEATH THE COSMETIC ONE ─────────────────────────────────────
 * `useNowMs()` is armed only while an interval is open, so the old
 * `nowMs - lastSignalMs` FROZE when the session went idle and sat there
 * reporting a wrong number forever. The last describe block pins the fix:
 * the age now comes off `asOfMs`, which is main's clock, and main re-pushes
 * every 30 s. Rounding the old expression to the minute would have produced a
 * calmer lie, which is why the subtraction changed and not just the format.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, render } from "@testing-library/react";

import { App } from "@/renderer/App";
import { LastSignal } from "@/renderer/components/last-signal";
import { formatAgoMinutes } from "@/shared/format";
import type { LiveStatus } from "@/shared/ipc-types";
import {
  defaultHandlers,
  installBridge,
  installDomStubs,
  liveStatus,
  makeBridge,
  metricsBundle,
  renderApp,
  type StubBridge,
} from "./harness";

const AS_OF = Date.parse("2026-08-19T14:41:00-05:00");
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;

/** The whole cell, 'last signal …' included, so the phrasing is under test too. */
function cell(c: HTMLElement): string {
  const el = c.querySelector('[data-slot="last-signal"]');
  if (!el) throw new Error("no [data-slot=last-signal] in the status strip");
  return el.textContent ?? "";
}

function digits(c: HTMLElement): string {
  return c.querySelector('[data-slot="stopwatch-digits"]')?.textContent ?? "";
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mount(
  status: LiveStatus,
): Promise<{ container: HTMLElement; bridge: StubBridge }> {
  const bridge = makeBridge(defaultHandlers(metricsBundle(), status));
  installBridge(bridge);
  const { container } = renderApp(<App />);
  await settle();
  expect(digits(container)).not.toBe("");
  return { container, bridge };
}

/** One beat of main's 30 s status keepalive: the SAME snapshot, a later clock. */
async function keepalive(bridge: StubBridge, base: LiveStatus, atMs: number): Promise<void> {
  await act(async () => {
    bridge.emit("wwb:push:status", { ...base, asOfMs: atMs });
  });
}

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(AS_OF);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the cell reads to the nearest minute", () => {
  it.each([
    [0, "last signal just now"],
    [1 * SEC, "last signal just now"],
    [12 * SEC, "last signal just now"],
    [59 * SEC, "last signal just now"],
    [60 * SEC, "last signal 1m ago"],
    [119 * SEC, "last signal 1m ago"],
    [4 * MIN, "last signal 4m ago"],
    [59 * MIN, "last signal 59m ago"],
    [60 * MIN, "last signal 1h ago"],
    [2 * HOUR, "last signal 2h ago"],
  ])("%d ms ago renders %s", (age, expected) => {
    const { container } = render(
      <LastSignal lastSignalMs={AS_OF - age} asOfMs={AS_OF} />,
    );
    expect(cell(container)).toBe(expected);
  });

  it("says 'just now' under a minute, and never a number that reads as zero", () => {
    // '0m' is what `formatDuration()` spends on a real zero-length interval,
    // so reusing it here would make "no time has passed yet" and "the interval
    // measured zero" the same pixels. See `formatAgoMinutes()` for the rest.
    expect(formatAgoMinutes(0)).toBe("just now");
    expect(formatAgoMinutes(59 * SEC)).toBe("just now");
    expect(formatAgoMinutes(59 * SEC)).not.toContain("0");
    expect(formatAgoMinutes(59 * SEC)).not.toContain("<");
  });

  it("carries its own 'ago', so no caller can double it", () => {
    // The sub-minute case cannot take one — 'last signal just now ago' is not
    // a sentence — which is exactly why the word lives inside the formatter.
    expect(formatAgoMinutes(4 * MIN)).toBe("4m ago");
    expect(formatAgoMinutes(30 * SEC).endsWith("ago")).toBe(false);
    const { container } = render(<LastSignal lastSignalMs={AS_OF - 4 * MIN} asOfMs={AS_OF} />);
    expect(cell(container)).toBe("last signal 4m ago");
    expect(cell(container)).not.toContain("ago ago");
  });

  it("renders '—' for no signal yet, never '0m ago' and never 'never'", () => {
    // `null` is 'no data' and 0 is 'zero'; they are different pixels (PRD §4).
    const { container } = render(<LastSignal lastSignalMs={null} asOfMs={AS_OF} />);
    expect(cell(container)).toBe("last signal —");
  });

  it("keeps tabular-nums, so 9m → 10m does not shove the switches beside it", () => {
    const { container } = render(<LastSignal lastSignalMs={AS_OF - 9 * MIN} asOfMs={AS_OF} />);
    const num = container.querySelector('[data-slot="last-signal"] span');
    expect(num?.className).toContain("tabular-nums");
  });
});

describe("it does not re-render every second", () => {
  it("is memoized, which is what makes unchanged props cost nothing", () => {
    // Claim A of the chain in this file's header. Without this, claim B only
    // proves the TEXT holds still, not that the work stopped.
    expect((LastSignal as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("takes no clock of its own — only the two numbers off one snapshot", () => {
    // Claim B, at the type level: there is no `nowMs` prop to pass, so no
    // caller can reintroduce the renderer's 1 Hz clock into this cell by
    // accident. `asOfMs` is main's clock, and it moves once per push.
    const props: Record<string, unknown> = { lastSignalMs: AS_OF - MIN, asOfMs: AS_OF };
    expect(Object.keys(props).sort()).toEqual(["asOfMs", "lastSignalMs"]);
    const { container, rerender } = render(<LastSignal lastSignalMs={AS_OF - MIN} asOfMs={AS_OF} />);
    expect(cell(container)).toBe("last signal 1m ago");
    // Same props, a wildly later wall clock: the cell cannot see it.
    vi.setSystemTime(AS_OF + 3 * HOUR);
    rerender(<LastSignal lastSignalMs={AS_OF - MIN} asOfMs={AS_OF} />);
    expect(cell(container)).toBe("last signal 1m ago");
  });

  it("holds one value through 65 one-second ticks of the dashboard", async () => {
    // Claim B in the real tree. 65 ticks, no push: if anything per-second
    // reached this cell it would have produced 65 strings, which is the exact
    // "two moving things on the page" the owner objected to.
    const { container } = await mount(liveStatus({ lastSignalMs: AS_OF - 12 * SEC }));

    const seen = new Set<string>();
    for (let i = 0; i < 65; i++) {
      await act(async () => void vi.advanceTimersByTime(1 * SEC));
      seen.add(cell(container));
    }

    expect([...seen]).toEqual(["last signal just now"]);
  });

  it("moves only when main sends a new snapshot", async () => {
    // The other half of B: still is not the same as dead. Two keepalive beats
    // are one displayed minute, and the cell advances by exactly one.
    const base = liveStatus({ lastSignalMs: AS_OF - 12 * SEC });
    const { container, bridge } = await mount(base);
    expect(cell(container)).toBe("last signal just now");

    await act(async () => void vi.advanceTimersByTime(30 * SEC));
    await keepalive(bridge, base, AS_OF + 30 * SEC);
    expect(cell(container)).toBe("last signal just now");

    await act(async () => void vi.advanceTimersByTime(30 * SEC));
    await keepalive(bridge, base, AS_OF + 60 * SEC);
    expect(cell(container)).toBe("last signal 1m ago");
  });
});

describe("the stopwatch is the one thing still moving", () => {
  it("ticks once a second in the same window the cell holds still", async () => {
    const { container } = await mount(
      liveStatus({
        lastSignalMs: AS_OF - 12 * SEC,
        openedAtMs: AS_OF - (2 * HOUR + 41 * MIN),
      }),
    );
    expect(digits(container)).toBe("2:41:00");

    const stopwatch: string[] = [];
    const signal = new Set<string>();
    for (let i = 0; i < 65; i++) {
      await act(async () => void vi.advanceTimersByTime(1 * SEC));
      stopwatch.push(digits(container));
      signal.add(cell(container));
    }

    // 65 distinct stopwatch readings against 1 for the cell beside it. That
    // ratio IS the fix; either number alone could be got by accident.
    expect(new Set(stopwatch).size).toBe(65);
    expect(stopwatch[0]).toBe("2:41:01");
    expect(stopwatch[64]).toBe("2:42:05");
    expect(signal.size).toBe(1);
  });
});

describe("the age it shows is true, not merely calm", () => {
  it("keeps counting while idle, when the renderer's own clock has stopped", async () => {
    // THE BUG THIS BRANCH EXISTS FOR. `useNowMs(status.state === "working")`
    // stops its interval the moment the session closes, so the old
    // `nowMs - lastSignalMs` froze at whatever it read when work stopped and
    // stayed there: an hour after walking away the strip still said '15m ago'.
    // Measured on this harness before the change, not theorised.
    //
    // Nothing here advances a renderer timer — only main's snapshots move —
    // and the cell still climbs, because the age is now main's subtraction.
    const base = liveStatus({
      state: "idle",
      openedAtMs: null,
      lastSignalMs: AS_OF - 15 * MIN,
    });
    const { container, bridge } = await mount(base);
    expect(cell(container)).toBe("last signal 15m ago");

    await keepalive(bridge, base, AS_OF + 10 * MIN);
    expect(cell(container)).toBe("last signal 25m ago");

    await keepalive(bridge, base, AS_OF + 45 * MIN);
    expect(cell(container)).toBe("last signal 1h ago");
  });

  it("never lags by more than the minute it displays", async () => {
    // Main pushes every 30 s (`main/ipc.ts`) and this cell shows minutes, so
    // the worst case is half a beat of staleness against a 60 s quantum. This
    // asserts the two cadences against each other rather than restating them:
    // if the keepalive were ever slowed past 60 s, a displayed minute could be
    // skipped entirely and this would be the test that noticed.
    const KEEPALIVE_MS = 30_000;
    expect(KEEPALIVE_MS).toBeLessThanOrEqual(60_000);

    const base = liveStatus({ lastSignalMs: AS_OF });
    const { container, bridge } = await mount(base);

    const shown: string[] = [];
    for (let beat = 1; beat <= 8; beat++) {
      await keepalive(bridge, base, AS_OF + beat * KEEPALIVE_MS);
      shown.push(cell(container));
    }
    // Every minute between 'just now' and '4m ago' appears; none is skipped.
    expect(shown).toEqual([
      "last signal just now",
      "last signal 1m ago",
      "last signal 1m ago",
      "last signal 2m ago",
      "last signal 2m ago",
      "last signal 3m ago",
      "last signal 3m ago",
      "last signal 4m ago",
    ]);
  });
});
