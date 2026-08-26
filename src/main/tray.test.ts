/**
 * The tray, against a hand-written `electron` double.
 *
 * The title is the product's headline number. Everything asserted here is a
 * number that would otherwise be wrong in a way nobody notices: a title that
 * freezes when a window closes, a title that shrinks when an interval ends, a
 * menu bar that redraws 300 times a second, a permission failure that reads as
 * a quiet zero.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => import("../../test/fakes/electron"));

import {
  Tray as FakeTray,
  addFakeWindow,
  app as fakeApp,
  dialog as fakeDialog,
  resetElectronMock,
  shell as fakeShell,
} from "../../test/fakes/electron";
import { onWindowAllClosed } from "./bootstrap";
import { TrayController, type TrayDeps } from "./tray";
import { countIntervals } from "../store";
import { seed } from "../../test/fakes/seed-db";
import { hoursThisWeek, hoursToday } from "../shared/format";
import { MIN, T0, fakeSettings, makeHarness, type Harness } from "../../test/helpers/runtime";
import { privacyPaneUrl } from "./onboarding";
import { traySessionLabel } from "../shared/stopwatch";

let h: Harness;
let tray: TrayController;

function makeTray(over: Partial<TrayDeps> = {}): TrayController {
  const deps: TrayDeps = {
    settings: fakeSettings(),
    showDashboard: () => {},
    showOnboarding: () => {},
    showSettings: () => {},
    openPrivacyPane: (which) => void fakeShell.openExternal(privacyPaneUrl(which)),
    showErrorBox: (title, content) => fakeDialog.showErrorBox(title, content),
    askJigglerPause: null,
    ...over,
  };
  const t = new TrayController(h.runtime, deps);
  // The single subscription `index.ts` makes.
  h.runtime.on("change", (kind) => t.onRuntimeChange(kind));
  t.refresh("boot");
  return t;
}

function instance(): FakeTray {
  return FakeTray.instances.at(-1)!;
}

/**
 * Flush microtasks WITHOUT advancing the clock.
 *
 * `vi.runOnlyPendingTimersAsync()` would also fire the armed 15-minute
 * deadline, closing an interval the test had not asked to close — which is how
 * a "two rows" assertion quietly becomes three.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function labels(t: TrayController): string[] {
  return t
    .template()
    .map((i: MenuItemConstructorOptions) => (typeof i.label === "string" ? i.label : "—"));
}

beforeEach(() => {
  resetElectronMock();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  tray?.destroy();
  h?.close();
  vi.useRealTimers();
});

describe("the title", () => {
  it("is hours TODAY, not hours this week", async () => {
    // The owner's words: "I want that to show how many hours I've worked that
    // day, not for the whole week, at least in the top toolbar." This reverses
    // PRD D3; `docs/DECISIONS.md` records the reversal.
    //
    // T0 is a Tuesday, so a Monday row is in the same ISO week but NOT today.
    // That is the whole point of this fixture: the two numbers are 3 hours
    // apart, so the title can only be read one way.
    h = await makeHarness();
    seed(h.db, [
      {
        id: "mon",
        machineId: "machine-a",
        start: "2023-11-13T09:00:00Z",
        end: "2023-11-13T12:00:00Z",
      },
    ]);

    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());
    // Past the idle timeout, so today's five minutes are a closed row too and
    // the hours cache has been invalidated by a real write.
    vi.advanceTimersByTime(16 * MIN);

    const status = h.runtime.liveStatus();
    const policy = fakeSettings().all();
    expect(hoursToday(status, policy, Date.now())).toBe(0.1);
    expect(hoursThisWeek(status, policy, Date.now())).toBe(3.1);

    expect(instance().title).toBe("0.1h");
    expect(instance().title).not.toBe("3.1h");
    // And the hover text does not describe it as the week's.
    expect(instance().tooltip).toBe("Work Week Buddy — 0.1h today");
  });

  it("keeps the week in the dropdown, beside Today", async () => {
    // Changing the title is not permission to drop the week's total. It moved
    // one glance further in; it did not go away.
    h = await makeHarness();
    seed(h.db, [
      {
        id: "mon",
        machineId: "machine-a",
        start: "2023-11-13T09:00:00Z",
        end: "2023-11-13T12:00:00Z",
      },
    ]);

    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());
    vi.advanceTimersByTime(16 * MIN);

    const l = labels(tray);
    expect(l.some((x) => x.startsWith("Today") && x.includes("0.1h"))).toBe(true);
    expect(l.some((x) => x.startsWith("This week") && x.includes("3.1h"))).toBe(true);
  });


  it("uses monospaced digits, or it jitters every minute", async () => {
    h = await makeHarness();
    tray = makeTray();
    expect(instance().titleOptions).toEqual({ fontType: "monospacedDigit" });
  });

  it("shows '—h' before any data and never a bare 0", async () => {
    h = await makeHarness();
    tray = makeTray();
    expect(instance().title).toBe("—h");
  });

  it("is never rewritten per second, however much the session clock moves", async () => {
    // The dashboard's stopwatch ticks at 1 Hz. The title must NOT: it is a live
    // string in the menu bar, and rewriting it reflows every icon to its left,
    // sixty times a minute, all day. The dropdown carries the seconds instead —
    // it is rebuilt on demand, so it costs nothing between glances.
    h = await makeHarness();
    tray = makeTray();
    h.source.key(Date.now());
    const before = instance().titles.length;

    for (let i = 0; i < 59; i++) {
      vi.advanceTimersByTime(1000);
      await settle();
    }
    expect(instance().titles.length).toBe(before);

    vi.advanceTimersByTime(1000);
    await settle();
    expect(instance().titles.length).toBe(before + 1);
  });

  it("advances once a minute from MAIN while an interval is open, and freezes after", async () => {
    h = await makeHarness();
    tray = makeTray();
    expect(tray.hasMinuteTimer).toBe(false);
    expect(tray.hasRolloverTimer).toBe(true);

    h.source.key(Date.now());
    expect(tray.hasMinuteTimer).toBe(true);
    // "Frozen" means the timer does not exist, not that it ticks and no-ops.
    expect(tray.hasRolloverTimer).toBe(false);

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(MIN);
      h.source.key(Date.now());
    }
    expect(instance().title).toBe("0.1h");

    vi.advanceTimersByTime(16 * MIN);
    expect(tray.hasMinuteTimer).toBe(false);
    expect(tray.hasRolloverTimer).toBe(true);
    // The number did NOT shrink when the interval closed: the tray credited the
    // open interval to its last signal all along, which is what the close rule
    // then wrote.
    expect(instance().title).toBe("0.1h");
  });

  it("ignores the 'signal' change entirely — 300 of them redraw nothing", async () => {
    h = await makeHarness();
    tray = makeTray();
    h.source.key(Date.now());
    const before = instance().titles.length;
    for (let i = 0; i < 300; i++) {
      tray.onRuntimeChange("signal");
      h.source.mouse(Date.now());
    }
    expect(instance().titles.length).toBe(before);
  });

  it("adds nothing for an open interval the jiggler has made uncountable", async () => {
    h = await makeHarness();
    tray = makeTray({ settings: fakeSettings({ countJigglerTime: 0 }) });
    h.source.key(Date.now());
    await tray.onJigglerToggled(true);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(MIN);
      h.source.key(Date.now());
    }
    // Ten minutes of jiggler-covered work and the headline has not moved off
    // zero: the same `v_countable` filter, applied to the row that does not
    // exist yet. (`0.0h`, not `—h`: a row DOES exist — the pre-boundary one —
    // so this is a true zero rather than an absence of data.)
    expect(instance().title).toBe("0.0h");
  });
});

describe("a closed window is not a stopped app", () => {
  it("closing the dashboard neither stops tracking nor freezes the title", async () => {
    h = await makeHarness();
    tray = makeTray();

    const win = addFakeWindow();
    h.source.key(Date.now());
    vi.advanceTimersByTime(MIN);
    h.source.key(Date.now());

    // The user presses ⌘W.
    win.destroy();
    onWindowAllClosed();

    // The app is emphatically still running.
    expect(fakeApp.quitCalls).toBe(0);
    expect(fakeApp.exitCode).toBeNull();
    expect(tray.hasMinuteTimer).toBe(true);

    const titlesBefore = instance().titles.length;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(MIN);
      h.source.key(Date.now());
    }
    // The minute timer lives in MAIN and is owned by no window, so the title
    // kept advancing with the window gone.
    expect(instance().titles.length).toBeGreaterThan(titlesBefore);
    expect(instance().title).toBe("0.1h");

    // …and the interval still lands in the store.
    vi.advanceTimersByTime(16 * MIN);
    expect(countIntervals(h.db)).toBe(1);
    expect(instance().title).toBe("0.1h");
  });
});

describe("the jiggler menu item", () => {
  it("closes the current interval and opens a new one, both homogeneous", async () => {
    h = await makeHarness();
    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());

    // Exactly what the menu item's click handler does.
    const item = tray.template().find((i) => i.label === "Jiggler")!;
    (item.click as () => void)();
    await settle();

    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());
    vi.advanceTimersByTime(16 * MIN);

    const stored = h.db
      .prepare("SELECT duration_s, jiggler_s, started_at_ms, ended_at_ms FROM work_interval ORDER BY started_at_ms")
      .all() as unknown as Array<{
      duration_s: number;
      jiggler_s: number;
      started_at_ms: number;
      ended_at_ms: number;
    }>;
    expect(stored).toHaveLength(2);
    expect(stored[0]!.ended_at_ms).toBe(stored[1]!.started_at_ms);
    for (const row of stored) expect([0, row.duration_s]).toContain(row.jiggler_s);
    expect(stored[0]!.jiggler_s).toBe(0);
    expect(stored[1]!.jiggler_s).toBe(stored[1]!.duration_s);
  });

  it("renders DISABLED with a reason when Accessibility is missing, never merely unchecked", async () => {
    h = await makeHarness({ start: false });
    h.source.perms = {
      listenEvent: true,
      postEvent: false,
      axTrusted: false,
      listenEventAccess: "granted",
      postEventAccess: "unknown",
    };
    await h.runtime.start();
    tray = makeTray();

    const item = tray.template().find((i) => String(i.label).startsWith("Jiggler"))!;
    expect(item.enabled).toBe(false);
    expect(item.label).toBe("Jiggler — needs Accessibility");
    expect(item.checked).toBe(false);
  });

  it("offers to pause, and remembers 'don't ask again'", async () => {
    h = await makeHarness();
    const settings = fakeSettings();
    let asked = 0;
    tray = makeTray({
      settings,
      askJigglerPause: async () => {
        asked++;
        return { response: 1, checkboxChecked: true };
      },
    });
    h.source.key(Date.now());

    await tray.onJigglerToggled(true);
    expect(asked).toBe(1);
    expect(h.runtime.toggles().paused).toBe(true);
    expect(settings.get("jigglerPausePrompt")).toBe("never");

    await tray.onJigglerToggled(false);
    await tray.onJigglerToggled(true);
    // Asked once, ever.
    expect(asked).toBe(1);
  });
});

describe("the degraded state is loud", () => {
  it("puts a ⚠︎ in the title, an alert icon, and a clickable fix at the very top", async () => {
    h = await makeHarness();
    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());
    vi.advanceTimersByTime(16 * MIN);
    expect(instance().title).toBe("0.1h");

    // Input Monitoring revoked in System Settings while the app runs.
    h.source.stripKeyboardBits();
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());

    expect(instance().title).toBe("0.1h ⚠︎");
    expect(instance().image.path).toMatch(/trayAlertTemplate\.png$/);
    expect(instance().tooltip).toMatch(/Keyboard is not being tracked/);

    const menu = tray.template();
    expect(labels(tray)[0]).toBe("⚠︎  Keyboard is not being tracked — fix…");
    // Enabled and clickable: a warning you cannot act on is decoration.
    expect(menu[0]!.enabled).not.toBe(false);
    (menu[0]!.click as () => void)();
    expect(fakeShell.opened.at(-1)).toContain("Privacy_ListenEvent");

    // The hours it DID record are still on screen. A silent zero is the failure
    // mode this whole path exists to prevent.
    expect(instance().title).not.toBe("—h ⚠︎");
    expect(h.runtime.liveStatus().closedHoursThisWeek).toBe(0.08);
  });
});

describe("the menu", () => {
  it("shows the current interval, today, this week and the machine", async () => {
    h = await makeHarness({ machineId: "0123456789abcdef" });
    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(4 * MIN);
    h.source.key(Date.now());

    const l = labels(tray);
    // Seconds, and the same string `stopwatchView()` puts on the dashboard —
    // the menu is rebuilt on every open, so it can afford the resolution the
    // TITLE cannot. See "the title" above for the other half of that rule.
    expect(l).toContain("Working · 0:04:00");
    expect(l).toContain(
      traySessionLabel(h.runtime.liveStatus(), fakeSettings().all(), Date.now()),
    );
    expect(l.some((x) => x.startsWith("last signal 0s ago"))).toBe(true);
    expect(l.some((x) => x.startsWith("Today"))).toBe(true);
    expect(l.some((x) => x.startsWith("This week"))).toBe(true);
    expect(l).toContain("Machine        01234567");
    expect(l).toContain("Keep awake");
    expect(l).toContain("Pause tracking");
    expect(l).toContain("Quit Work Week Buddy");
  });

  it("can reach Settings without opening the dashboard first", async () => {
    // The tray is where this app lives, and until this item existed there was
    // no way to enter a Worker URL at all in a packaged build — `devTools` is
    // off there, so the console workaround was gone too.
    h = await makeHarness();
    const opened: string[] = [];
    tray = makeTray({
      showSettings: () => opened.push("settings"),
      showDashboard: () => opened.push("dashboard"),
    });

    const item = tray.template().find((i) => i.label === "Settings…")!;
    expect(item).toBeDefined();
    (item.click as () => void)();
    // The settings WINDOW, not the dashboard. A menu item that lies about
    // where it goes is worse than one that is missing.
    expect(opened).toEqual(["settings"]);
  });

  it("surfaces a failed sync rather than swallowing it", async () => {
    h = await makeHarness();
    tray = makeTray();
    const item = tray.template().find((i) => i.label === "Sync now")!;
    (item.click as () => void)();
    await settle();
    expect(fakeDialog.errors.at(-1)?.title).toBe("Sync failed");
  });
});

describe("the day-rollover timer", () => {
  /** Five minutes of work, then idle past the timeout. Title reads 0.1h. */
  async function idleAfterSixMinutes(): Promise<void> {
    h = await makeHarness();
    tray = makeTray();
    h.source.key(Date.now());
    vi.advanceTimersByTime(5 * MIN);
    h.source.key(Date.now());
    vi.advanceTimersByTime(16 * MIN);
    expect(instance().title).toBe("0.1h");
    expect(tray.hasRolloverTimer).toBe(true);
  }

  it("re-renders at midnight so an idle morning does not show yesterday's total", async () => {
    // This is the timer the title change made load-bearing. The title is a
    // TODAY figure now, so it goes stale every single midnight — not only
    // Monday's, which is all the old week-rollover timer ever woke up for. A
    // Mac left alone overnight has nothing else that would redraw it.
    await idleAfterSixMinutes();

    // 26 hours: enough to have crossed one local midnight in ANY zone, which
    // is what `nextLocalMidnight()` schedules against — it reads the OS zone,
    // exactly as the `nextIsoWeekStart()` it replaced did, while this harness
    // runs the store on UTC. Not enough to reach a Monday: T0 is a Tuesday, so
    // this lands on Wednesday and crosses no week boundary at all.
    vi.advanceTimersByTime(26 * 60 * MIN);

    // Yesterday's 0.1h is gone from the menu bar without anyone touching a key.
    expect(instance().title).toBe("0.0h");
    // And it is a DAY that rolled over, not a week: the same 0.1h is still
    // sitting in "This week" one line down. If the timer had stayed weekly,
    // these two would both still read 0.1h and nothing here would notice.
    expect(labels(tray).some((x) => x.startsWith("This week") && x.includes("0.1h"))).toBe(true);
    // And tomorrow's timer is armed, not left dangling.
    expect(tray.hasRolloverTimer).toBe(true);
  });

  it("still carries the week over, because Monday 00:00 is one of its midnights", async () => {
    // The week total moved to the dropdown; it did not stop needing to roll
    // over. A daily timer is a superset of the weekly one it replaced, and
    // this is the assertion that says so out loud.
    await idleAfterSixMinutes();
    expect(labels(tray).some((x) => x.startsWith("This week") && x.includes("0.1h"))).toBe(true);

    vi.advanceTimersByTime(8 * 24 * 60 * MIN);

    expect(labels(tray).some((x) => x.startsWith("This week") && x.includes("0.0h"))).toBe(true);
    expect(instance().title).toBe("0.0h");
    expect(tray.hasRolloverTimer).toBe(true);
  });
});
