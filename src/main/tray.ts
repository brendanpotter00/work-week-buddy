/**
 * The tray — `docs/IMPL_UI.md` §3.
 *
 * THE TITLE RULE: the title is HOURS THIS WEEK (PRD D3), updated once a minute
 * FROM THE MAIN PROCESS while an interval is open, and frozen otherwise.
 *
 * Three sub-rules, each of which is a bug if you get it wrong:
 *
 * 1. The number includes the open interval, credited to `lastSignalMs` — never
 *    to `now`. Crediting to `now` makes the headline number SHRINK by up to
 *    fifteen minutes the moment the interval closes, and a number that goes
 *    down is a support ticket. Crediting to the last signal makes the tray show
 *    exactly what the close rule will write. `creditedOpenMs()` does this once,
 *    for the tray and the dashboard both.
 * 2. The open interval contributes NOTHING when it will not be countable — the
 *    same `v_countable` filters, applied to the row that does not exist yet.
 * 3. "Frozen" means the minute timer DOES NOT EXIST, not that it ticks and
 *    no-ops. While frozen a one-shot week-rollover timer is armed instead;
 *    without it an idle Monday 00:00 leaves last week's total on the menu bar
 *    until the next keystroke.
 *
 * `setTitle(text, { fontType: "monospacedDigit" })` is not optional: it is the
 * menu bar's `tabular-nums`, and without it the title jitters horizontally
 * every minute.
 *
 * The timers live here, in main, and are owned by no window. Closing the
 * dashboard must not stop tracking and must not freeze this title — the window
 * is a view, not the app.
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";

import {
  formatAgo,
  formatHours,
  formatTrayTitle,
  hoursThisWeek,
  hoursToday,
  nextIsoWeekStart,
} from "../shared/format";
import { traySessionLabel } from "../shared/stopwatch";
import type { DegradedReason, LiveStatus, PermissionKey } from "../shared/ipc-types";
import { log } from "./log";
import type { AppRuntime, RuntimeChange } from "./runtime";
import type { MainSettings } from "./settings";

export type RefreshReason =
  | "boot"
  | "interval-open"
  | "interval-close"
  | "minute"
  | "toggles"
  | "permissions"
  | "tap-health"
  | "rows-pulled"
  | "resume"
  | "unlock"
  | "week-rollover";

type IconName = "trayTemplate" | "trayIdleTemplate" | "trayAlertTemplate";

/**
 * Degraded reasons, most-damaging first. The tooltip and the top menu item show
 * `degraded[0]`, so the reason that makes a NUMBER wrong outranks the rest.
 */
const DEGRADED_COPY: Record<
  DegradedReason,
  { menu: string; fix: "onboarding" | "inputMonitoring" | "accessibility" | "dashboard" }
> = {
  keyboard_permission_missing: {
    menu: "Keyboard is not being tracked — fix…",
    fix: "inputMonitoring",
  },
  relaunch_required: { menu: "Restart to finish granting access…", fix: "onboarding" },
  accessibility_missing: { menu: "Jiggler needs Accessibility — fix…", fix: "accessibility" },
  tap_lost: { menu: "Input tap was lost — see Doctor…", fix: "dashboard" },
  sync_silent_72h: { menu: "No cloud write in 72 h — see Doctor…", fix: "dashboard" },
  fingerprint_mismatch: { menu: "Cloud fingerprint mismatch — Doctor…", fix: "dashboard" },
  db_unwritable: { menu: "Local database is not writable…", fix: "dashboard" },
  selftest_failed: { menu: "Jiggler safety check FAILED — see Doctor…", fix: "dashboard" },
};

export interface MessageBoxAnswer {
  response: number;
  checkboxChecked: boolean;
}

export interface TrayDeps {
  readonly settings: {
    all(): Readonly<MainSettings>;
    get<K extends keyof MainSettings>(k: K): MainSettings[K];
    set<K extends keyof MainSettings>(k: K, v: MainSettings[K]): Promise<void>;
  };
  readonly showDashboard: () => void;
  readonly showOnboarding: () => void;
  /**
   * REQUIRED, unlike most of what this app treats as optional.
   *
   * Sync is configured in that window and nowhere else, and the tray is where
   * this app lives — an owner who has just deployed a Worker reaches for the
   * menu bar, not for a dashboard he may never open. A default that opened the
   * dashboard instead would be a menu item that lies about where it goes.
   */
  readonly showSettings: () => void;
  readonly openPrivacyPane: (which: PermissionKey) => void;
  readonly showErrorBox: (title: string, content: string) => void;
  readonly askJigglerPause: (() => Promise<MessageBoxAnswer>) | null;
  readonly isPackaged?: boolean;
  readonly now?: () => number;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
  readonly schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly unschedule?: (t: NodeJS.Timeout) => void;
}

export class TrayController {
  private readonly tray: Tray;
  private minuteTimer: NodeJS.Timeout | null = null;
  private rolloverTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly runtime: AppRuntime,
    private readonly deps: TrayDeps,
  ) {
    this.tray = new Tray(this.icon("trayIdleTemplate"));
    this.tray.setIgnoreDoubleClickEvents(true);
    // The menu is rebuilt on every open so its numbers are fresh.
    // `setContextMenu()` would snapshot them at construction time and then lie.
    this.tray.on("click", () => this.popUp());
    this.tray.on("right-click", () => this.popUp());
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private icon(name: IconName): Electron.NativeImage {
    // Lazy, not module scope: reading `app.isPackaged` at import time runs
    // before `app.setName()` in index.ts and before `whenReady`.
    const dir = this.deps.isPackaged
      ? join(process.resourcesPath, "resources")
      : join(process.cwd(), "resources");
    const img = nativeImage.createFromPath(join(dir, `${name}.png`));
    // A missing file yields an empty image, and an empty image with a title is
    // a perfectly good text-only menu-bar item — which is what ships until the
    // three template PNGs land. Never a crash over a missing asset.
    if (img.isEmpty()) return nativeImage.createEmpty();
    // Explicit: do not rely on the "…Template" filename convention. Template
    // images are recoloured by macOS for light/dark and for the highlighted
    // state, which is why the alert state is carried by SHAPE and by the ⚠︎ in
    // the title rather than by colour.
    img.setTemplateImage(true);
    return img;
  }

  /** `RuntimeChange` → a refresh reason. `signal` is dropped on the floor. */
  onRuntimeChange(kind: RuntimeChange): void {
    // 300 events/second during a mouse drag. Redrawing the menu bar that often
    // is a visible stutter and buys nothing: the number only moves once a minute.
    if (kind === "signal") return;
    switch (kind) {
      case "interval-open":
      case "interval-close":
      case "toggles":
      case "permissions":
      case "tap-health":
      case "rows-pulled":
        this.refresh(kind);
        return;
      default:
        this.refresh("boot");
    }
  }

  refresh(reason: RefreshReason): void {
    if (this.destroyed) return;
    let status: LiveStatus;
    try {
      status = this.runtime.liveStatus();
    } catch (err) {
      // Never let the tray take the app down. A tray that cannot draw is a
      // cosmetic failure; a main process that died has stopped measuring.
      log.error("liveStatus() threw during tray refresh", err);
      return;
    }

    const policy = this.deps.settings.all();
    const hours = hoursThisWeek(status, policy, this.now());
    const degraded = status.degraded.length > 0;
    const first = status.degraded[0];

    this.tray.setTitle(formatTrayTitle(hours, degraded), { fontType: "monospacedDigit" });
    this.tray.setImage(
      this.icon(
        degraded
          ? "trayAlertTemplate"
          : status.state === "working"
            ? "trayTemplate"
            : "trayIdleTemplate",
      ),
    );
    this.tray.setToolTip(
      first !== undefined
        ? `Work Week Buddy — ${DEGRADED_COPY[first].menu}`
        : `Work Week Buddy — ${formatHours(hours)}h this week`,
    );

    this.armTimers(status, reason);
  }

  /**
   * The minute timer exists ONLY while an interval is open. While it is frozen,
   * a one-shot week-rollover timer keeps Monday 00:00 honest.
   */
  private armTimers(status: LiveStatus, reason: RefreshReason): void {
    const open = status.state === "working";
    const setRepeating = this.deps.setRepeating ?? setInterval;
    const clearRepeating = this.deps.clearRepeating ?? clearInterval;

    if (open && this.minuteTimer === null) {
      this.minuteTimer = setRepeating(() => this.refresh("minute"), 60_000);
      this.clearRollover();
    }
    if (!open && this.minuteTimer !== null) {
      clearRepeating(this.minuteTimer);
      this.minuteTimer = null;
    }
    if (reason === "week-rollover" || reason === "resume") {
      // A timer that slept through the boundary is not to be trusted.
      this.clearRollover();
    }
    if (!open && this.rolloverTimer === null) this.armRollover();
  }

  private armRollover(): void {
    const schedule = this.deps.schedule ?? setTimeout;
    const delay = Math.max(1000, nextIsoWeekStart(this.now()) - this.now());
    // ≤ 7 days: no 32-bit setTimeout overflow risk.
    this.rolloverTimer = schedule(() => {
      this.rolloverTimer = null;
      this.refresh("week-rollover");
    }, delay);
  }

  private clearRollover(): void {
    if (this.rolloverTimer === null) return;
    (this.deps.unschedule ?? clearTimeout)(this.rolloverTimer);
    this.rolloverTimer = null;
  }

  /** Exposed for the tests: the menu is data, so assert on the data. */
  template(): MenuItemConstructorOptions[] {
    const s = this.runtime.liveStatus();
    const t = this.runtime.toggles();
    const now = this.now();
    const policy = this.deps.settings.all();
    const items: MenuItemConstructorOptions[] = [];

    // ── degraded first: loud, at the very top, ENABLED, with a fix. PRD §3.7 ──
    for (const reason of s.degraded) {
      const copy = DEGRADED_COPY[reason];
      items.push({
        label: `⚠︎  ${copy.menu}`,
        click: () => {
          if (copy.fix === "inputMonitoring") this.deps.openPrivacyPane("inputMonitoring");
          else if (copy.fix === "accessibility") this.deps.openPrivacyPane("accessibility");
          else if (copy.fix === "onboarding") this.deps.showOnboarding();
          else this.deps.showDashboard();
        },
      });
    }
    if (s.degraded.length > 0) items.push({ type: "separator" });

    // ── current interval ────────────────────────────────────────────────────
    // The same state machine the dashboard's stopwatch runs, so the menu bar
    // and the window cannot disagree about the session that is open right now.
    // Seconds are safe HERE and nowhere else in the tray: the menu is rebuilt
    // on every open, so this string is computed once per glance. The TITLE is
    // still a once-a-minute hours figure — a per-second title reflows every
    // icon to its left, sixty times a minute, forever.
    items.push({ label: traySessionLabel(s, policy, now), enabled: false });
    items.push({
      label:
        s.lastSignalMs === null
          ? "no signal yet"
          : `last signal ${formatAgo(now - s.lastSignalMs)} ago${
              s.lastSignalKind === "camera"
                ? " · camera"
                : s.lastSignalKind === "mic"
                  ? " · microphone"
                  : ""
            }`,
      enabled: false,
    });
    items.push({ type: "separator" });

    // `hoursToday`, not `closedHoursToday`: "This week" below already includes
    // the open interval, and two totals in one menu that disagree about the
    // last two hours is a support ticket.
    items.push({
      label: `Today          ${formatHours(hoursToday(s, policy, now))}h`,
      enabled: false,
    });
    items.push({
      label: `This week      ${formatHours(hoursThisWeek(s, policy, now))}h`,
      enabled: false,
    });
    items.push({
      label: `Machine        ${s.machineLabel || s.machineId.slice(0, 8)}`,
      enabled: false,
    });
    items.push({ type: "separator" });

    // ── the three toggles ───────────────────────────────────────────────────
    items.push({
      // A toggle that appears on but does nothing is the failure mode to design
      // against (MACOS.md §6). Without Accessibility the switch is DISABLED and
      // says why — it is never merely unchecked.
      label: t.jigglerAvailable ? "Jiggler" : `Jiggler — ${t.jigglerUnavailableReason}`,
      type: "checkbox",
      checked: t.jiggler,
      enabled: t.jigglerAvailable,
      click: () => void this.onJigglerToggled(!t.jiggler),
    });
    items.push({
      label: "Keep awake",
      type: "checkbox",
      checked: t.keepAwake,
      click: () =>
        void this.runtime
          .setToggle({ key: "keepAwake", value: !t.keepAwake, source: "tray" })
          .then(() => this.refresh("toggles")),
    });
    items.push({
      label: "Pause tracking",
      type: "checkbox",
      checked: t.paused,
      click: () =>
        void this.runtime
          .setToggle({ key: "paused", value: !t.paused, source: "tray" })
          .then(() => this.refresh("toggles")),
    });
    items.push({ type: "separator" });

    items.push({ label: "Open Dashboard…", click: () => this.deps.showDashboard() });
    items.push({
      label: "Sync now",
      click: () => {
        void this.runtime.flushNow().then((r) => {
          if (!r.ok) this.deps.showErrorBox("Sync failed", r.error ?? "unknown error");
        });
      },
    });
    items.push({ label: "Doctor…", click: () => this.deps.showDashboard() });
    // Sync is turned on HERE, from the menu bar, without opening the dashboard
    // first. Until this item existed there was no way to enter a Worker URL at
    // all in a packaged build — `devTools` is off there, so the console
    // workaround was gone too.
    items.push({ label: "Settings…", click: () => this.deps.showSettings() });
    items.push({ type: "separator" });
    items.push({ label: "Quit Work Week Buddy", role: "quit" });

    return items;
  }

  private popUp(): void {
    this.tray.popUpContextMenu(Menu.buildFromTemplate(this.template()));
  }

  /**
   * Toggling the jiggler is an INTERVAL BOUNDARY (PRD §6 D1, AGENTS.md).
   *
   * `setToggle()` resolves only after the boundary is committed and the
   * successor interval is open, so the refresh below reads a consistent state.
   * AWAITING IT IS LOAD-BEARING: refreshing first would paint the pre-boundary
   * numbers and then never correct them until the next minute tick.
   */
  async onJigglerToggled(next: boolean): Promise<void> {
    await this.runtime.setToggle({ key: "jiggler", value: next, source: "tray" });
    this.refresh("toggles");
    if (next) await this.offerPause();
  }

  /** The "…and pause tracking?" affordance. */
  private async offerPause(): Promise<void> {
    if (this.deps.askJigglerPause === null) return;
    if (this.deps.settings.get("jigglerPausePrompt") === "never") return;
    if (this.runtime.toggles().paused) return;

    const { response, checkboxChecked } = await this.deps.askJigglerPause();
    if (checkboxChecked) await this.deps.settings.set("jigglerPausePrompt", "never");
    if (response === 1) {
      await this.runtime.setToggle({ key: "paused", value: true, source: "tray" });
      this.refresh("toggles");
    }
  }

  /** Test seam: the current title, without reaching into Electron internals. */
  get title(): string {
    return this.tray.getTitle();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.minuteTimer !== null) {
      (this.deps.clearRepeating ?? clearInterval)(this.minuteTimer);
      this.minuteTimer = null;
    }
    this.clearRollover();
    this.tray.destroy();
  }

  /** Test seam. `null` while frozen — "frozen" means the timer does not exist. */
  get hasMinuteTimer(): boolean {
    return this.minuteTimer !== null;
  }

  get hasRolloverTimer(): boolean {
    return this.rolloverTimer !== null;
  }
}
