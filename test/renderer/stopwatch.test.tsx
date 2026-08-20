// @vitest-environment jsdom
/**
 * The stopwatch, in the dashboard, against a stubbed bridge.
 *
 * `src/shared/stopwatch.test.ts` proves the arithmetic. This file proves the
 * things only a mounted component can be wrong about: that the digits actually
 * move once a second, that they stop when they are supposed to, that a new
 * interval starts from zero rather than from the last one, and that the 1 Hz
 * interval is released on unmount — a leaked timer in an app that runs from
 * login until shutdown is a real leak, not a theoretical one.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

import { App } from "@/renderer/App";
import type { LiveStatus } from "@/shared/ipc-types";
import {
  defaultHandlers,
  installBridge,
  installDomStubs,
  liveStatus,
  makeBridge,
  metricsBundle,
  renderApp,
} from "./harness";

const AS_OF = Date.parse("2026-08-19T14:41:00-05:00");
const SEC = 1000;
const MIN = 60_000;

function digits(container: HTMLElement): string {
  return container.querySelector('[data-slot="stopwatch-digits"]')?.textContent ?? "";
}

function eyebrow(container: HTMLElement): string {
  return container.querySelector('[data-slot="stopwatch-label"]')?.textContent ?? "";
}

function note(container: HTMLElement): string {
  return container.querySelector('[data-slot="stopwatch-note"]')?.textContent ?? "";
}

function tone(container: HTMLElement): string {
  return container.querySelector('[data-slot="stopwatch"]')?.getAttribute("data-tone") ?? "";
}

function isPulsing(container: HTMLElement): boolean {
  return container.querySelector('[data-slot="stopwatch-ping"]') !== null;
}

/**
 * Let the mount's promise chains settle WITHOUT advancing the clock.
 *
 * `waitFor()` is not usable here: it polls on a timer, and the timers are fake
 * for this whole file because that is the only way to prove what a 1 Hz clock
 * does. The stub bridge resolves synchronously, so a handful of microtask turns
 * is all that is ever needed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Mount the dashboard with one status snapshot, at a known instant. */
async function mount(status: LiveStatus): Promise<ReturnType<typeof renderApp>> {
  const bridge = makeBridge(defaultHandlers(metricsBundle(), status));
  installBridge(bridge);
  const r = renderApp(<App />);
  await settle();
  expect(digits(r.container)).not.toBe("");
  return r;
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

describe("while working", () => {
  it("advances once a second, without being told anything new", async () => {
    // No push, no invoke, no `deadlineMs`: the component recomputes from the
    // absolute epoch ms the snapshot already carried.
    const { container } = await mount(
      liveStatus({ openedAtMs: AS_OF - (2 * 3600_000 + 41 * MIN) }),
    );
    expect(digits(container)).toBe("2:41:00");
    expect(tone(container)).toBe("running");
    expect(isPulsing(container)).toBe(true);

    await act(async () => void vi.advanceTimersByTime(1 * SEC));
    expect(digits(container)).toBe("2:41:01");

    await act(async () => void vi.advanceTimersByTime(2 * SEC));
    expect(digits(container)).toBe("2:41:03");
  });

  it("keeps its digit groups, so nothing beside it shifts", async () => {
    const { container } = await mount(liveStatus({ openedAtMs: AS_OF - 7 * SEC }));
    expect(digits(container)).toBe("0:00:07");
    expect(
      container.querySelector('[data-slot="stopwatch-digits"]')?.className,
    ).toContain("tabular-nums");
  });

  it("answers 'and how much today?' beside it", async () => {
    const { container } = await mount(liveStatus({ closedHoursToday: 5.1 }));
    const today = container.querySelector('[data-slot="stopwatch-today"]');
    // 5.1 closed + the 2h41m open interval, credited to its last signal.
    expect(today?.textContent).toContain("7.8");
    expect(today?.textContent).toContain("counted so far");
  });
});

describe("while paused", () => {
  it("does not advance — not on the first tick and not on the sixtieth", async () => {
    const { container } = await mount(
      liveStatus({ state: "paused", asOfMs: AS_OF, openedAtMs: AS_OF - 4 * MIN }),
    );
    expect(digits(container)).toBe("0:04:00");
    expect(tone(container)).toBe("paused");
    expect(eyebrow(container)).toBe("Paused");
    expect(isPulsing(container)).toBe(false);

    await act(async () => void vi.advanceTimersByTime(60 * SEC));
    expect(digits(container)).toBe("0:04:00");
  });
});

describe("while held open by a camera", () => {
  it("stops at the cap rather than counting a forgotten meeting all night", async () => {
    const { container } = await mount(
      liveStatus({
        openedAtMs: AS_OF - 30 * MIN,
        heldOpenBy: "camera",
        heldUntilMs: AS_OF + 5 * SEC,
        lastSignalKind: "camera",
      }),
    );
    expect(digits(container)).toBe("0:30:00");
    expect(tone(container)).toBe("held");
    expect(note(container)).toContain("Held open by the camera");

    await act(async () => void vi.advanceTimersByTime(5 * SEC));
    expect(digits(container)).toBe("0:30:05");
    expect(tone(container)).toBe("capped");
    expect(isPulsing(container)).toBe(false);

    // Two more minutes of nobody remembering to leave the call.
    await act(async () => void vi.advanceTimersByTime(2 * MIN));
    expect(digits(container)).toBe("0:30:05");
    expect(eyebrow(container)).toBe("Capped");
  });
});

describe("across an interval boundary", () => {
  it("goes to a dash when the interval closes, and restarts from zero", async () => {
    const bridge = makeBridge(
      defaultHandlers(metricsBundle(), liveStatus({ openedAtMs: AS_OF - 40 * MIN })),
    );
    installBridge(bridge);
    const { container } = renderApp(<App />);
    await settle();
    expect(digits(container)).toBe("0:40:00");

    // idle_timeout closes it. A frozen 0:40:00 would read as "still running".
    act(() =>
      bridge.emit(
        "wwb:push:status",
        liveStatus({ state: "idle", openedAtMs: null, lastSignalMs: AS_OF - 15 * MIN }),
      ),
    );
    expect(digits(container)).toBe("—");
    expect(eyebrow(container)).toBe("Idle");
    expect(isPulsing(container)).toBe(false);

    // The next keystroke opens a new one. It must not inherit the old session.
    act(() =>
      bridge.emit(
        "wwb:push:status",
        liveStatus({ asOfMs: AS_OF, openedAtMs: AS_OF, lastSignalMs: AS_OF }),
      ),
    );
    expect(digits(container)).toBe("0:00:00");

    await act(async () => void vi.advanceTimersByTime(2 * SEC));
    expect(digits(container)).toBe("0:00:02");
  });
});

describe("the states that need a caveat look different", () => {
  it("renders idle, jiggler-on and degraded distinctly from a healthy clock", async () => {
    const seen: Array<{ tone: string; label: string; pulsing: boolean }> = [];

    for (const status of [
      liveStatus(),
      liveStatus({ state: "idle", openedAtMs: null }),
      liveStatus({ jigglerOnForOpenInterval: true }),
      liveStatus({ degraded: ["keyboard_permission_missing"] }),
    ]) {
      installBridge(undefined);
      const { container, unmount } = await mount(status);
      seen.push({
        tone: tone(container),
        label: eyebrow(container),
        pulsing: isPulsing(container),
      });
      unmount();
    }

    expect(seen).toEqual([
      { tone: "running", label: "Working", pulsing: true },
      { tone: "idle", label: "Idle", pulsing: false },
      { tone: "uncounted", label: "Not counted", pulsing: false },
      { tone: "degraded", label: "Unverified", pulsing: false },
    ]);
  });

  it("says the jiggler is why, and says the time will not count", async () => {
    const { container } = await mount(liveStatus({ jigglerOnForOpenInterval: true }));
    expect(note(container)).toContain("will not count toward your hours");
    // …and Today says so beside the number, rather than quietly excluding it.
    expect(container.querySelector('[data-slot="stopwatch-today"]')?.textContent).toContain(
      "not counting this session",
    );
  });

  it("wears the same ⚠︎ as the stat cards when the input signal is broken", async () => {
    const { container } = await mount(liveStatus({ degraded: ["tap_lost"] }));
    expect(container.querySelector('[data-slot="stopwatch"]')?.textContent).toContain("⚠︎");
    expect(note(container)).toContain("input tap is dead");
  });

  it("leaves the clock alone for a degraded reason that is not about the clock", async () => {
    // `accessibility_missing` means the JIGGLER cannot post. Muting a correct
    // number for it teaches the reader to ignore every other warning.
    const { container } = await mount(liveStatus({ degraded: ["accessibility_missing"] }));
    expect(tone(container)).toBe("running");
    expect(isPulsing(container)).toBe(true);
  });
});

describe("the 1 Hz clock", () => {
  it("is released on unmount — this app is open from login until shutdown", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");

    const { unmount } = await mount(liveStatus());

    const perSecond = set.mock.calls
      .map((call, i) => ({ delay: call[1], id: set.mock.results[i]?.value as unknown }))
      .filter((c) => c.delay === 1000);
    expect(perSecond.length).toBeGreaterThan(0);

    unmount();
    for (const { id } of perSecond) expect(cleared).toHaveBeenCalledWith(id);

    set.mockRestore();
    cleared.mockRestore();
  });

  it("does not exist at all while nothing is running", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const { unmount } = await mount(liveStatus({ state: "idle", openedAtMs: null }));
    expect(set.mock.calls.filter((c) => c[1] === 1000)).toHaveLength(0);
    unmount();
    set.mockRestore();
  });
});
