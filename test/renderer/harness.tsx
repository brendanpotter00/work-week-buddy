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

import { apportion } from "@/core";
import { ThemeProvider } from "@/renderer/lib/theme-provider";
import type { WwbBridge } from "@/renderer/lib/ipc";
import type {
  AppInfo,
  DoctorReport,
  HeatmapDay,
  InvokeChannel,
  InvokeContract,
  LiveStatus,
  MetricsBundle,
  PermissionSnapshot,
  PushChannel,
  PushContract,
  SelfTestResult,
  SyncConfigState,
  Toggles,
  UiSettings,
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

export function renderApp(
  ui: React.ReactElement,
  theme: "light" | "dark" = "light",
): RenderResult {
  // The provider is what writes `.dark` onto <html>, and `useResolvedTheme()`
  // reads it back off there — so a test that wants the dark palette has to go
  // through the provider rather than setting the class itself, which the
  // provider would immediately overwrite.
  return render(<ThemeProvider defaultTheme={theme}>{ui}</ThemeProvider>);
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

export interface BarMachine {
  machineId: string;
  label: string;
  /** Relative share of each day. The bar's own total is `hours`, not this. */
  weight: number;
}

/**
 * The two Macs `metricsBundle()` puts in `byMachine`, in the same order — so a
 * fixture bar and a fixture breakdown describe the same week.
 */
export const BAR_MACHINES: readonly BarMachine[] = [
  { machineId: "machine-a", label: "Work laptop", weight: 2 },
  { machineId: "machine-b", label: "Home iMac", weight: 1 },
];

/**
 * The bars, split per machine THROUGH `apportion()` — the same function main
 * uses.
 *
 * Not a convenience. `WeekBar.machines` has to sum to `WeekBar.hours` exactly,
 * and a fixture that split the hours by hand would be free to violate the one
 * invariant the chart depends on, which would make every test written against
 * it agree with a bundle main could never produce.
 */
export function weekBars(
  weekStart: string,
  hours: readonly number[],
  machines: readonly BarMachine[] = BAR_MACHINES,
): WeekBar[] {
  return DAY_NAMES.map((day, i) => {
    const h = hours[i] ?? 0;
    const parts = apportion(
      machines.map((m) => m.weight),
      Math.round(h * 100),
    );
    return {
      day,
      date: addLocalDays(weekStart, i),
      hours: h,
      machines: machines.map((m, k) => ({
        machineId: m.machineId,
        label: m.label,
        hours: (parts[k] ?? 0) / 100,
      })),
    };
  });
}

/** A populated bundle — the numbers the mockup shows, over the real contract. */
export function metricsBundle(over: Partial<MetricsBundle> = {}): MetricsBundle {
  const heatmap = heatmapDays("2025-08-18", 371, (i) => (i % 7 >= 5 ? 0 : 6.5 + (i % 3)));
  return {
    generatedAtMs: Date.parse("2026-08-19T14:41:00-05:00"),
    policy: { minIntervalS: 90, countJigglerTime: 0, graceS: 0, heatmapThresholdsH: [2, 5, 8] },
    weekStart: "2026-08-17",
    week: { hours: 36.5, prevHours: 32.3 },
    // 5.1 closed today — the same number `liveStatus()` carries as
    // `closedHoursToday`, because main computes both with `hoursOnDate()`.
    today: { date: "2026-08-19", hours: 5.1, prevHours: 4.3 },
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
    today: { date: "2026-08-19", hours: null, prevHours: null },
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

export function uiSettings(over: Partial<UiSettings> = {}): UiSettings {
  return {
    machineLabel: "Work laptop",
    idleTimeoutMin: 15,
    windowBackground: "#FFFFFF",
    heatmapThresholdsH: [2, 5, 8],
    minIntervalS: 90,
    countJigglerTime: 0,
    graceS: 0,
    syncWorkerUrl: "",
    syncWorkerUrlAlt: "",
    ...over,
  };
}

/**
 * THE DEFAULT IS "NOT CONFIGURED", which is the state a real install is in
 * until the owner deploys a Worker. A fixture whose default was "everything
 * working" would let the screen that handles the ordinary case go untested —
 * the same reasoning `permissionSnapshot()` gets above.
 */
export function syncConfigState(over: Partial<SyncConfigState> = {}): SyncConfigState {
  return {
    workerUrl: "",
    // "" by default, and that is the ordinary state: most installs have one
    // address, and the two-address path must never be the one that is exercised
    // just because a fixture made it the default.
    workerUrlAlt: "",
    tokenPresent: false,
    configured: false,
    error: null,
    vaultAvailable: true,
    ...over,
  };
}

export function selfTestResult(over: Partial<SelfTestResult> = {}): SelfTestResult {
  return {
    ranAtMs: Date.parse("2026-08-19T09:00:00-05:00"),
    passed: true,
    appVersion: "0.1.0",
    checks: [{ id: "userData-is-a-number", passed: true, detail: "read back 0x57574b31" }],
    ...over,
  };
}

/**
 * A doctor report with everything green and sync UNCONFIGURED — the shape main
 * returns on a fresh profile. Sections are overridable one at a time so a test
 * can make exactly one thing wrong.
 */
export function doctorReport(over: Partial<DoctorReport> = {}): DoctorReport {
  const now = Date.parse("2026-08-19T14:41:00-05:00");
  return {
    generatedAtMs: now,
    allGreen: true,
    app: {
      version: "0.1.0",
      electron: "43.4.1",
      bundleId: "com.bpotter.workweekbuddy",
      execPath: "/Applications/Work Week Buddy.app",
      isPackaged: true,
      launchedAtMs: now - 3_600_000,
    },
    machine: {
      machineId: "machine-a",
      label: "Work laptop",
      osVersion: "26.5.1",
      tz: "America/Chicago",
    },
    permissions: grantedSnapshot(),
    tap: {
      created: true,
      enabled: true,
      grantedMaskHex: "0x1c00",
      keyboardBitsPresent: true,
      flagsChangedBitPresent: true,
      probed: true,
      runLoopModes: ["default", "common"],
      eventsSinceLaunch: 422,
      lastEventMs: now - 12_000,
      disabledByTimeoutCount: 0,
      disabledByUserInputCount: 0,
      reEnabledCount: 0,
      reEnableFailedCount: 0,
      revivedCount: 0,
      lastRevivalMs: null,
      lastRevivalOutcome: null,
      drainsOverdue: 0,
      worstDrainLagMs: 0,
      tapLostRows: 0,
      lastWatchdogTickMs: now - 60_000,
    },
    camera: { probed: true, deviceCount: 2, inUse: false, lastReadMs: now },
    mic: { inUse: false },
    sync: {
      configured: false,
      pendingRows: 0,
      lastFlushOkMs: null,
      lastFlushError: null,
      lastPullMs: null,
      lastPullError: null,
      watermark: 0,
      lastCloudWriteMs: null,
      silentForMs: null,
    },
    fingerprint: {
      checkedAtMs: null,
      matched: null,
      localCount: null,
      cloudCount: null,
      localSha: null,
      cloudSha: null,
    },
    backup: { lastPath: null, lastAtMs: null, ageDays: null, destination: null, kept: 0 },
    selfTest: null,
    db: {
      path: "/tmp/wwb/wwb.sqlite3",
      sizeBytes: 4096,
      rows: 1284,
      openIntervalPresent: false,
      integrityOk: true,
    },
    autostart: {
      probed: true,
      installed: true,
      loaded: true,
      plistPath: "~/Library/LaunchAgents/com.bpotter.workweekbuddy.plist",
      execPath: "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy",
      execExists: true,
      execMatchesRunningApp: true,
    },
    codesign: { probed: true, designatedRequirementSha256: "abc", valid: true },
    ...over,
  };
}

/** Handlers that answer every channel the dashboard uses. */
export function defaultHandlers(metrics: MetricsBundle, status = liveStatus()): Handlers {
  return {
    "wwb:app:info": () => appInfo(),
    "wwb:status:get": () => status,
    "wwb:metrics:get": () => metrics,
    "wwb:toggles:get": () => toggles(),
    "wwb:toggles:set": (c) => toggles({ [c.key]: c.value }),
    "wwb:settings:set": () => uiSettings(),
    // The status strip's Sync now button reads this. The default is NOT
    // configured, which is the state a real install is in — see
    // `syncConfigState()`.
    "wwb:sync:config": () => syncConfigState(),
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

// ── the title bar ───────────────────────────────────────────────────────────

/**
 * Everything a person can click, in one selector.
 *
 * A `-webkit-app-region: drag` region SWALLOWS clicks on whatever it covers, so
 * the list has to be generous rather than accurate: the failure it guards is a
 * control that quietly stops working because it landed inside the title bar
 * without opting out.
 */
export const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="switch"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  "[tabindex]",
].join(",");

const DRAG = "[-webkit-app-region:drag]";
const NO_DRAG = "[-webkit-app-region:no-drag]";

const classOf = (el: Element): string => el.getAttribute("class") ?? "";

/**
 * Does `el` end up OUTSIDE the drag region?
 *
 * Chromium resolves draggable regions as nested rectangles: `drag` claims a
 * box, a descendant's `no-drag` punches a hole in it, and a deeper `drag`
 * fills the hole back in. So the answer is the first declaration found walking
 * up from the element — not the element's own class alone, which would fail a
 * button correctly covered by a `no-drag` wrapper.
 */
export function optsOutOfDrag(el: Element, stopAt: Element): boolean {
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    const cls = classOf(n);
    if (cls.includes(NO_DRAG)) return true;
    if (cls.includes(DRAG)) return false;
    if (n === stopAt) return false;
  }
  return false;
}

export interface TitleBarProbe {
  root: HTMLElement;
  bar: HTMLElement;
  /** Controls inside the bar that a drag region would swallow clicks on. */
  interactive: HTMLElement[];
}

export function titleBarOf(container: HTMLElement): TitleBarProbe {
  const root = container.querySelector<HTMLElement>("[data-view]");
  if (!root) throw new Error("no [data-view] root rendered");
  const bar = root.querySelector<HTMLElement>('[data-slot="title-bar"]');
  if (!bar) throw new Error("no [data-slot=title-bar] — this window has no title bar at all");
  return {
    root,
    bar,
    interactive: Array.from(bar.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)),
  };
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
