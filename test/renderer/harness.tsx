/**
 * The renderer test harness.
 *
 * The dashboard is tested against a STUBBED BRIDGE, never against mock data
 * baked into the component: `design/mock-data.reference.ts` is a shape
 * reference and is deliberately not shipped (it also carries a UTC date bug).
 * Everything the dashboard shows therefore has to arrive over
 * `window.wwb.invoke`, and these fixtures are the only place a number is
 * invented.
 */
import * as React from "react";
import { render, type RenderResult } from "@testing-library/react";

import { ThemeProvider } from "@/renderer/lib/theme-provider";
import type { WwbBridge } from "@/renderer/lib/ipc";
import type {
  AppInfo,
  HeatmapDay,
  InvokeChannel,
  InvokeContract,
  LiveStatus,
  MetricsBundle,
  PermissionSnapshot,
  PushChannel,
  PushContract,
  Toggles,
  WeekBar,
} from "@/shared/ipc-types";

/**
 * jsdom implements neither `matchMedia` (ThemeProvider, react-activity-calendar
 * and recharts all call it) nor `ResizeObserver` (recharts' ResponsiveContainer).
 * Both are missing rather than broken, so the failure is a TypeError at mount.
 */
export function installDomStubs(): void {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }
  if (typeof window.CSS?.supports !== "function") {
    // react-activity-calendar validates every colour in the 5-stop ramp with
    // CSS.supports(). jsdom has no CSS object at all.
    Object.defineProperty(window, "CSS", {
      writable: true,
      value: { supports: () => true, escape: (s: string) => s },
    });
  }
  if (typeof window.ResizeObserver !== "function") {
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    });
  }
  const svg = window.SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
  if (typeof svg.getBBox !== "function") {
    // jsdom does not lay out SVG; react-activity-calendar measures its weekday
    // labels with getBBox() to reserve their gutter.
    svg.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
  }
  window.localStorage.clear();
  document.documentElement.className = "";
}

type Handlers = {
  [K in InvokeChannel]?: (
    payload: InvokeContract[K]["req"],
  ) => InvokeContract[K]["res"] | Promise<InvokeContract[K]["res"]>;
};

export interface StubBridge extends WwbBridge {
  /** every invoke, in order, so a test can assert what the dashboard asked for */
  calls: Array<{ channel: InvokeChannel; payload: unknown }>;
  /** push a complete snapshot the way main does */
  emit<K extends PushChannel>(channel: K, payload: PushContract[K]): void;
  listenerCount(channel: PushChannel): number;
}

export function makeBridge(handlers: Handlers): StubBridge {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: StubBridge["calls"] = [];

  return {
    calls,
    invoke(channel, payload) {
      calls.push({ channel, payload });
      const fn = handlers[channel] as
        | ((p: unknown) => unknown | Promise<unknown>)
        | undefined;
      if (!fn) {
        return Promise.reject(new Error(`no stub for ${channel}`)) as never;
      }
      try {
        return Promise.resolve(fn(payload)) as never;
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e))) as never;
      }
    },
    on(channel, cb) {
      const set = listeners.get(channel) ?? new Set();
      const fn = cb as (p: unknown) => void;
      set.add(fn);
      listeners.set(channel, set);
      return () => {
        set.delete(fn);
      };
    },
    emit(channel, payload) {
      for (const fn of listeners.get(channel) ?? []) fn(payload);
    },
    listenerCount(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

export function installBridge(bridge: StubBridge | undefined): void {
  if (bridge) window.wwb = bridge;
  // `window.wwb` is typed as always present; deleting it is how a preload that
  // failed to load is simulated.
  else delete (window as { wwb?: unknown }).wwb;
}

export function renderApp(ui: React.ReactElement): RenderResult {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

// ── fixtures ────────────────────────────────────────────────────────────────

export function appInfo(over: Partial<AppInfo> = {}): AppInfo {
  return {
    version: "0.1.0",
    machineId: "machine-a",
    machineLabel: "Work laptop",
    tz: "America/Chicago",
    isPackaged: true,
    idleTimeoutMin: 15,
    ...over,
  };
}

export function toggles(over: Partial<Toggles> = {}): Toggles {
  return {
    jiggler: false,
    keepAwake: false,
    paused: false,
    jigglerAvailable: true,
    jigglerUnavailableReason: null,
    ...over,
  };
}

/**
 * The state a fresh install is REALLY in, and the default here on purpose:
 * Input Monitoring granted in System Settings, keyboard bits absent from the
 * live tap, Accessibility never granted. That is `relaunchRequired`, it is what
 * the owner hit, and a fixture whose default is "everything fine" would let the
 * screen that handles it go untested.
 */
export function permissionSnapshot(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    checkedAtMs: Date.parse("2026-08-19T14:41:00-05:00"),
    inputMonitoring: "granted",
    accessibility: "undetermined",
    keyboardBitsGranted: false,
    flagsChangedBitGranted: false,
    grantedMaskHex: "0x0",
    relaunchRequired: true,
    promptConsumed: { inputMonitoring: false, accessibility: false },
    microphone: "not-required",
    ...over,
  };
}

/** Everything granted and the live tap agreeing — the end state. */
export function grantedSnapshot(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return permissionSnapshot({
    accessibility: "granted",
    keyboardBitsGranted: true,
    flagsChangedBitGranted: true,
    grantedMaskHex: "0x1c00",
    relaunchRequired: false,
    ...over,
  });
}

export function liveStatus(over: Partial<LiveStatus> = {}): LiveStatus {
  const asOf = Date.parse("2026-08-19T14:41:00-05:00");
  return {
    asOfMs: asOf,
    state: "working",
    openedAtMs: asOf - 2 * 3_600_000 - 41 * 60_000,
    lastSignalMs: asOf - 12_000,
    lastSignalKind: "input",
    deadlineMs: asOf + 15 * 60_000,
    heldOpenBy: null,
    heldUntilMs: null,
    cameraOn: false,
    micCapturing: false,
    meetingAppRunning: false,
    machineId: "machine-a",
    machineLabel: "Work laptop",
    closedHoursThisWeek: 33.8,
    closedHoursToday: 5.1,
    jigglerOnForOpenInterval: false,
    degraded: [],
    ...over,
  };
}

/** The thresholds `MetricsPolicy.heatmapThresholdsH` carries by default. */
export function levelFor(hours: number): HeatmapDay["level"] {
  if (hours <= 0) return 0;
  if (hours < 2) return 1;
  if (hours < 5) return 2;
  if (hours < 8) return 3;
  return 4;
}

/** Local-date arithmetic, never UTC (`docs/IMPL_UI.md` §0.1 rule 8). */
function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * `n` consecutive local days, one entry per day, exactly as query 4 plus
 * `applyThresholds()` produce them in main. `hoursFor` is the only input.
 */
export function heatmapDays(
  firstDate: string,
  n: number,
  hoursFor: (i: number, date: string) => number,
): HeatmapDay[] {
  const out: HeatmapDay[] = [];
  for (let i = 0; i < n; i++) {
    const date = addLocalDays(firstDate, i);
    const count = Math.round(hoursFor(i, date) * 100) / 100;
    out.push({ date, count, level: levelFor(count) });
  }
  return out;
}

const DAY_NAMES: WeekBar["day"][] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekBars(weekStart: string, hours: readonly number[]): WeekBar[] {
  return DAY_NAMES.map((day, i) => ({
    day,
    date: addLocalDays(weekStart, i),
    hours: hours[i] ?? 0,
  }));
}

/** A populated bundle — the numbers the mockup shows, over the real contract. */
export function metricsBundle(over: Partial<MetricsBundle> = {}): MetricsBundle {
  const heatmap = heatmapDays("2025-08-18", 371, (i) => (i % 7 >= 5 ? 0 : 6.5 + (i % 3)));
  return {
    generatedAtMs: Date.parse("2026-08-19T14:41:00-05:00"),
    policy: { minIntervalS: 90, countJigglerTime: 0, graceS: 0, heatmapThresholdsH: [2, 5, 8] },
    weekStart: "2026-08-17",
    week: { hours: 36.5, prevHours: 32.3 },
    interval: { avgMin: 112, nIntervals: 20 },
    allTime: {
      avgMin: 98,
      nIntervals: 1284,
      hoursTracked: 2614.25,
      sinceDate: "2025-08-18",
    },
    longest: {
      singleHours: 6.2,
      singleMachineLabel: "Work laptop",
      singleDate: "2026-03-04",
      mergedHours: null,
      mergedDate: null,
    },
    heatmap,
    weekBars: weekBars("2026-08-17", [7.8, 8.6, 6.1, 9.2, 4.3, 0, 0.5]),
    byMachine: [
      {
        machineId: "machine-a",
        label: "Work laptop",
        hours: 24.5,
        intervals: 14,
        meetingHours: 3.2,
        jigglerHours: 0,
        share: 0.67,
        lastSeenMs: Date.parse("2026-08-19T14:41:00-05:00"),
      },
      {
        machineId: "machine-b",
        label: "Home iMac",
        hours: 12,
        intervals: 6,
        meetingHours: 0.5,
        jigglerHours: 0,
        share: 0.33,
        lastSeenMs: Date.parse("2026-08-18T22:10:00-05:00"),
      },
    ],
    honesty: { date: "2026-08-19", naiveSumH: 5.4, unionH: 5.1 },
    ...over,
  };
}

/**
 * What `buildMetrics()` returns against a database with no countable rows:
 * every metric `null`, no heatmap rows at all, week bars zero-filled.
 * `null` is "no data", `0` is "zero hours", and they are different pixels.
 */
export function emptyMetricsBundle(): MetricsBundle {
  return metricsBundle({
    week: { hours: null, prevHours: null },
    interval: { avgMin: null, nIntervals: 0 },
    allTime: { avgMin: null, nIntervals: 0, hoursTracked: null, sinceDate: null },
    longest: {
      singleHours: null,
      singleMachineLabel: null,
      singleDate: null,
      mergedHours: null,
      mergedDate: null,
    },
    heatmap: [],
    weekBars: weekBars("2026-08-17", [0, 0, 0, 0, 0, 0, 0]),
    byMachine: [],
    honesty: { date: "2026-08-19", naiveSumH: null, unionH: null },
  });
}

/** Handlers that answer every channel the dashboard uses. */
export function defaultHandlers(metrics: MetricsBundle, status = liveStatus()): Handlers {
  return {
    "wwb:app:info": () => appInfo(),
    "wwb:status:get": () => status,
    "wwb:metrics:get": () => metrics,
    "wwb:toggles:get": () => toggles(),
    "wwb:toggles:set": (c) => toggles({ [c.key]: c.value }),
    "wwb:settings:set": () => ({
      machineLabel: "Work laptop",
      idleTimeoutMin: 15,
      windowBackground: "#FFFFFF",
      meetingApps: [],
      micIgnoreApps: [],
      heatmapThresholdsH: [2, 5, 8],
      minIntervalS: 90,
      countJigglerTime: 0,
      graceS: 0,
      syncWorkerUrl: "",
    }),
  };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

export function statCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stat-card"]'));
}

export function cardByLabel(container: HTMLElement, label: string): HTMLElement {
  const card = statCards(container).find((c) => c.firstElementChild?.textContent === label);
  if (!card) throw new Error(`no stat card labelled "${label}"`);
  return card;
}

export function cardValue(card: HTMLElement): string {
  return card.children[1]?.firstElementChild?.textContent ?? "";
}

export function cardSub(card: HTMLElement): string {
  return card.children[2]?.textContent ?? "";
}

/**
 * Tag names + classes, ignoring text. Two renders with identical skeletons
 * occupy identical space, which is how "the grid does not reflow when data
 * arrives" is asserted without a layout engine.
 */
export function skeletonOf(el: Element): string {
  const kids = Array.from(el.children).map(skeletonOf).join("");
  return `<${el.tagName}.${el.getAttribute("class") ?? ""}>${kids}</${el.tagName}>`;
}
