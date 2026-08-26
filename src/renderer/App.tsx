/**
 * The dashboard — a port of `design/App.reference.tsx`, which is the visual
 * acceptance target rather than a sketch (`design/README.md`). Layout, spacing,
 * radii, the 5-stop heatmap ramp and every `tabular-nums` are carried over
 * unchanged; the mock data import is the only thing replaced.
 *
 * `docs/IMPL_UI.md` §5.6 lists every intended change. The ones that fail
 * SILENTLY if dropped:
 *
 *  - `react-activity-calendar/tooltips.css` (line below). Without it the
 *    tooltips render as unstyled text at the top-left of the page. No error.
 *  - `colorScheme={resolvedTheme}` on `<ActivityCalendar>`. The component reads
 *    `prefers-color-scheme`; the app follows a class. Press `d` to force light
 *    while macOS is dark and the heatmap alone stays dark.
 *  - The 5-stop `theme` arrays. A 2-stop ramp renders a realistic full-time
 *    year as one unreadable near-black block.
 *  - `overflow-x-auto` around the calendar. The 53-week SVG is ~745 px and does
 *    not shrink; `windows.ts` pairs this with `minWidth: 880`.
 *
 * Data rules this file obeys:
 *
 *  - `null` renders `—`; `0` renders `0`. They are different pixels (PRD §4).
 *  - Nothing is scheduled from `status.deadlineMs`. The 1 Hz clock only ever
 *    recomputes from absolute epoch ms, so a collapsed renderer timer
 *    (`AGENTS.md` trap #10) costs a stale frame, never a wrong number.
 *  - The heatmap level is NOT computed here. It is a policy knob and it comes
 *    off the wire already resolved (`docs/IMPL_UI.md` §5.8).
 */
import * as React from "react";
import { ActivityCalendar } from "react-activity-calendar";
import "react-activity-calendar/tooltips.css";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  Coffee,
  Laptop,
  Monitor,
  Moon,
  MousePointer2,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { DeviceName } from "@/renderer/components/device-name";
import { LastSignal } from "@/renderer/components/last-signal";
import { LiveStopwatch } from "@/renderer/components/live-stopwatch";
import { TitleBar } from "@/renderer/components/title-bar";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/renderer/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { Separator } from "@/renderer/components/ui/separator";
import { Switch } from "@/renderer/components/ui/switch";
import { formatLocalDate, formatMonthYear } from "@/renderer/lib/format-date";
import { useTheme } from "@/renderer/lib/theme-provider";
import {
  ipc,
  useAppInfo,
  useLiveStatus,
  useMetrics,
  useNowMs,
  useToggles,
} from "@/renderer/lib/ipc";
import { useResolvedTheme } from "@/renderer/lib/use-resolved-theme";
import { useThemeMirror } from "@/renderer/lib/use-theme-mirror";
import { DEFAULT_METRICS_POLICY, type DegradedReason } from "@/shared/ipc-types";
import {
  formatCount,
  formatDayDelta,
  formatDuration,
  formatHeaderDate,
  formatHours,
  formatWeekDelta,
  hoursToday,
} from "@/shared/format";

const chartConfig = {
  hours: { label: "Hours", color: "var(--foreground)" },
} satisfies ChartConfig;

/** §4.5 — every degraded reason says what is wrong with the numbers, in words. */
const DEGRADED_COPY: Record<DegradedReason, string> = {
  keyboard_permission_missing:
    "Input Monitoring is missing the keyboard bits — typing is invisible and hours read low.",
  accessibility_missing: "Accessibility is not granted, so the jiggler cannot post. Tracking is unaffected.",
  tap_lost: "The event tap died. No input is being recorded until the app is relaunched.",
  relaunch_required: "A permission was granted but the running tap still lacks it. Relaunch to pick it up.",
  sync_silent_72h: "Nothing has reached the cloud for over 72 hours.",
  fingerprint_mismatch: "The local database and the cloud disagree about how many rows exist.",
  db_unwritable: "The database cannot be written. Nothing is being saved.",
  selftest_failed:
    "The jiggler safety check failed, so the jiggler was switched off. This Mac may not be able to tell the jiggler’s own input apart from yours — treat hours recorded with it on as suspect.",
};

function StatCard({
  label,
  value,
  unit,
  sub,
  warn = false,
  className = "",
}: {
  label: string;
  /** `null` renders '—'. A real 0 renders '0'. They are different things. */
  value: string | null;
  unit?: string;
  sub?: string | null;
  warn?: boolean;
  /** The card's share of the stat row's grid — see the row's own comment. */
  className?: string;
}): React.ReactElement {
  return (
    <div
      data-slot="stat-card"
      className={`rounded-lg border border-border bg-card px-4 py-3.5 ${className}`}
    >
      <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-heading text-[28px] leading-none font-semibold tracking-tight tabular-nums">
          {value ?? "—"}
        </span>
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
        {warn ? (
          <span
            className="text-destructive ml-1 text-sm"
            title="This number is incomplete — see the banner above"
          >
            ⚠︎
          </span>
        ) : null}
      </div>
      {/* Always rendered — a non-breaking space when empty — so the four cards
          keep identical heights on first run and the grid does not reflow when
          the data arrives. PRD §4. */}
      <div className="mt-1.5 text-xs text-muted-foreground">{sub ?? " "}</div>
    </div>
  );
}

function ThemeToggle(): React.ReactElement {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          Light {theme === "light" && "·"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          Dark {theme === "dark" && "·"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          System {theme === "system" && "·"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function App(): React.ReactElement {
  useThemeMirror();

  const statusQ = useLiveStatus();
  const appInfoQ = useAppInfo();
  const togglesQ = useToggles();
  const metricsQ = useMetrics();
  const resolvedTheme = useResolvedTheme();

  const status = statusQ.data;
  const metrics = metricsQ.data;
  const toggles = togglesQ.data;

  // Armed only while an interval is open. §5.7.
  const nowMs = useNowMs(status?.state === "working");

  const degraded = status?.degraded ?? [];
  const keyboardBroken = degraded.includes("keyboard_permission_missing");

  // ONE policy for every hours figure on this page, and it is the one the
  // BUNDLE was computed under rather than whatever the settings pane holds
  // now — so the caveat the stopwatch shows and the numbers the stat cards
  // show were decided by the same `v_countable` filters. The stopwatch card
  // is handed this same object, which is what makes its "Today" and the Today
  // stat card the same expression rather than two that merely agree today.
  const metricsPolicy = metrics?.policy ?? DEFAULT_METRICS_POLICY;
  // The delta's own left-hand side: the LIVE figure the card prints, not the
  // closed one, or the sub-line would contradict the number above it.
  const todayHours = status
    ? hoursToday(status, metricsPolicy, nowMs)
    : (metrics?.today.hours ?? null);

  const errors = [statusQ.error, metricsQ.error, appInfoQ.error, togglesQ.error].filter(
    (e): e is string => e !== null,
  );
  const { reload: reloadStatus } = statusQ;
  const { reload: reloadMetrics } = metricsQ;
  const { reload: reloadAppInfo } = appInfoQ;
  const { reload: reloadToggles } = togglesQ;
  const retry = React.useCallback(() => {
    reloadStatus();
    reloadMetrics();
    reloadAppInfo();
    reloadToggles();
  }, [reloadStatus, reloadMetrics, reloadAppInfo, reloadToggles]);

  return (
    <div data-view="dashboard" className="min-h-svh bg-background">
      {/* THE TITLE BAR, and it is a direct child of the view root on purpose:
          full window width, above the content column rather than inside it.
          It used to be the `<header>` down in that column, which is why the
          top 40 px and both 32-px gutters — the whole strip a hand reaches for
          — were not draggable. `components/title-bar.tsx` has the story.
          `sticky`, so scrolling the dashboard never takes it away. */}
      <TitleBar window="dashboard">
        <div className="mx-auto flex w-full max-w-[1100px] items-start justify-between px-8 pb-2">
          <div>
            <h1 className="font-heading text-[22px] leading-tight font-semibold tracking-tight">
              Work Week Buddy
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{formatHeaderDate(nowMs)}</p>
          </div>
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            {/* Settings is its own WINDOW, so this asks main to open it rather
                than navigating away and taking the dashboard with it. The tray
                has the same item — the two are the only routes in, and until
                they existed sync could not be configured at all. */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              title="Settings"
              onClick={() => void ipc.openSettings().catch(() => undefined)}
            >
              <SettingsIcon />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </TitleBar>

      {/* pb-10 only: the title bar above owns the top inset now, and its own
          pb-2 plus this first section's mt-4 come to the 24 px the stopwatch's
          mt-6 used to put under the header. Nothing moved. */}
      <div className="mx-auto w-full max-w-[1100px] px-8 pb-10">
        {errors.length > 0 ? (
          <AlertBanner
            variant="error"
            title="Couldn’t read your data"
            lines={errors}
            actionLabel="Retry"
            onAction={retry}
          />
        ) : null}

        {degraded.length > 0 ? (
          <AlertBanner
            variant="warning"
            title="These numbers are incomplete"
            lines={degraded.map((r) => DEGRADED_COPY[r])}
          />
        ) : null}

        {/* Context strip — machine, signal, toggles.
            IT NO LONGER SAYS WHAT STATE YOU ARE IN. It used to carry its own
            pulsing dot and its own "Working", six pixels under the stopwatch's,
            so the word appeared twice on one screen and the two could disagree:
            this one read `status.state` and knew three states, while the
            stopwatch runs the seven-state machine in `shared/stopwatch.ts` and
            knows that a capped camera hold, a jiggled session and a broken tap
            are not the same "Working". The richer one won; this row keeps what
            it was the only source of.
            It no longer carries an elapsed figure either. It used to print
            `creditedOpenMs()` under the label "counted", a second duration a
            few pixels from the stopwatch's own digits, and the session length
            is what the stopwatch is for. `creditedOpenMs()` is still what
            every hours figure on this page is built on — it is simply not
            printed twice. */}
        <section
          data-slot="status-strip"
          className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Laptop className="size-3.5" />
            {status?.machineLabel || "this Mac"}
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <LastSignal lastSignalMs={status?.lastSignalMs ?? null} asOfMs={status?.asOfMs ?? 0} />
          <div className="ml-auto flex items-center gap-4">
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={toggles?.jigglerUnavailableReason ?? undefined}
            >
              <MousePointer2 className="size-3.5" />
              Jiggler
              {/* Never a switch that appears on and does nothing (MACOS.md §6). */}
              <Switch
                aria-label="Jiggler"
                checked={!!toggles?.jiggler}
                disabled={!toggles?.jigglerAvailable}
                onCheckedChange={(v) => togglesQ.setToggle("jiggler", v)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Coffee className="size-3.5" />
              {/* "Keep awake" everywhere: `caffeinate` is a banned implementation
                  (MACOS.md §5) and two names for one toggle is a bug factory. */}
              Keep awake
              <Switch
                aria-label="Keep awake"
                checked={!!toggles?.keepAwake}
                onCheckedChange={(v) => togglesQ.setToggle("keepAwake", v)}
              />
            </label>
          </div>
        </section>

        {/* Stat row — TWO ROWS OF A SIX-COLUMN GRID, not five columns.
            Five is prime, so any equal-column grid that is not 1 or 5 wide
            leaves the last card stranded on a row of its own, and five equal
            columns at the window's own minimum (880px, `WINDOW_SIZE.dashboard`)
            gives each card 122px of content — an 11px uppercase label like
            "AVG INTERVAL · ALL TIME" wraps to two lines in that.

            So: `span-3 + span-3` fills row one and `span-2 × 3` fills row two,
            exactly, at every width. The split is also the meaning — the two
            TOTALS ("how much have I worked") lead, and the three per-interval
            figures ("what shape are my sessions") sit under them.

            `sm:`, not `lg:`. The dashboard's minWidth is 880px, which is BELOW
            Tailwind's lg breakpoint of 1024 — so an `lg:` grid silently falls
            back to `sm:grid-cols-2` for every window between 880 and 1023, and
            that is the range the orphan would have appeared in. */}
        <section
          data-slot="stat-row"
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-6"
        >
          <StatCard
            className="sm:col-span-3"
            label="This week"
            value={metrics ? formatHours(metrics.week.hours) : null}
            unit="h"
            sub={metrics ? formatWeekDelta(metrics.week.hours, metrics.week.prevHours) : null}
            warn={keyboardBroken}
          />
          {/* TODAY, AND IT IS THE MENU BAR'S NUMBER.
              `hoursToday()` from `src/shared/format.ts` — the same call the
              tray title, the tray dropdown's "Today" line and the stopwatch
              card three blocks down all make, on the same `LiveStatus` and the
              same policy. Same function, same arguments, same answer: there is
              no arithmetic here for the four of them to drift apart in.

              That means the card counts the interval that is OPEN right now,
              credited to its last real signal (AGENTS.md's rule that outranks
              everything), on top of the closed union total for the local day.
              `metrics.today.hours` is the same closed total straight from the
              database — it is what this shows if the live snapshot has not
              arrived, and being closed-only it can only ever be behind, never
              ahead of what the close rule will write. */}
          <StatCard
            className="sm:col-span-3"
            label="Today"
            value={formatHours(todayHours)}
            unit="h"
            sub={metrics ? formatDayDelta(todayHours, metrics.today.prevHours) : null}
            warn={keyboardBroken}
          />
          <StatCard
            className="sm:col-span-2"
            label="Avg interval · week"
            value={
              metrics?.interval.avgMin != null
                ? formatDuration(metrics.interval.avgMin * 60_000)
                : null
            }
            sub={metrics ? `${formatCount(metrics.interval.nIntervals)} intervals` : null}
          />
          <StatCard
            className="sm:col-span-2"
            label="Avg interval · all time"
            value={
              metrics?.allTime.avgMin != null
                ? formatDuration(metrics.allTime.avgMin * 60_000)
                : null
            }
            sub={metrics ? `${formatCount(metrics.allTime.nIntervals)} intervals` : null}
          />
          <StatCard
            className="sm:col-span-2"
            label="Longest interval"
            value={
              metrics?.longest.singleHours != null
                ? formatDuration(metrics.longest.singleHours * 3_600_000)
                : null
            }
            sub={
              metrics?.longest.singleDate
                ? `${formatLocalDate(metrics.longest.singleDate)} · ${metrics.longest.singleMachineLabel ?? "unknown"}`
                : null
            }
          />
        </section>

        {/* The live session: how long it has been running, and how much of
            today is already banked. `metrics.policy` rather than the settings
            pane, so the caveat the stopwatch shows and the numbers the stat
            cards show were computed under the same policy.

            IT SITS HERE, below the tracked figures, at the owner's request —
            "the timer should be below all those metric tracked blocks as well,
            above the GitHub graph thing". It was the top of the page; the
            things that are true right now (which Mac, counted, last signal,
            the two switches) and the week's totals now come first. The order
            is asserted in `test/renderer/dashboard.test.tsx`, because an order
            nothing checks is an order that drifts back. */}
        <LiveStopwatch status={status} policy={metricsPolicy} nowMs={nowMs} />

        {/* Heatmap */}
        <section
          data-slot="heatmap"
          className="mt-4 rounded-lg border border-border bg-card px-5 py-5"
        >
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-sm font-medium">Daily hours</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {metrics?.allTime.hoursTracked != null && metrics.allTime.sinceDate !== null
                ? `${formatCount(Math.round(metrics.allTime.hoursTracked))} h tracked since ${formatMonthYear(metrics.allTime.sinceDate)}`
                : "—"}
            </span>
          </div>
          {/* The 53-week SVG is ~745 px and does not shrink. §5.4. */}
          <div className="mt-4 overflow-x-auto">
            <ActivityCalendar
              // ActivityCalendar THROWS on an empty array ("Activity data must
              // not be empty"), and a first-run database returns no heatmap
              // rows at all. `loading` renders its own full-size skeleton,
              // which is also the empty state the largest card on the page
              // needs.
              loading={metrics === null || metrics.heatmap.length === 0}
              data={metrics?.heatmap ?? []}
              colorScheme={resolvedTheme}
              blockSize={11}
              blockMargin={3}
              blockRadius={2}
              fontSize={11}
              weekStart={1}
              maxLevel={4}
              showWeekdayLabels={["mon", "wed", "fri"]}
              showTotalCount={false}
              theme={{
                light: ["#F1F0EE", "#D3D1CB", "#A8A49C", "#6B6862", "#37352F"],
                dark: ["#242424", "#3A3A3A", "#5C5C5C", "#8A8A8A", "#D4D4D4"],
              }}
              labels={{ legend: { less: "0h", more: "8h+" } }}
              tooltips={{ activity: { text: (a) => `${a.count.toFixed(1)} h on ${a.date}` } }}
            />
          </div>
        </section>

        {/* Bottom split */}
        <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-lg border border-border bg-card px-5 py-5">
            <h2 className="font-heading text-sm font-medium">This week</h2>
            <ChartContainer config={chartConfig} className="mt-4 h-[180px] w-full">
              <BarChart data={metrics?.weekBars ?? []} margin={{ left: 0, right: 0, top: 4 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.35} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="hours" fill="var(--color-hours)" radius={3} maxBarSize={34} />
              </BarChart>
            </ChartContainer>
          </div>

          <div className="rounded-lg border border-border bg-card px-5 py-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-medium">By machine</h2>
              <span className="text-xs text-muted-foreground">this week</span>
            </div>
            <div className="mt-4 flex flex-col gap-3.5">
              {metrics && metrics.byMachine.length > 0 ? (
                metrics.byMachine.map((m) => (
                  <div key={m.machineId} data-slot="machine-row">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <Monitor className="size-3.5 text-muted-foreground" />
                        {m.label}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatHours(m.hours)}h
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      {/* `share` is computed in main so the renderer stays
                          arithmetic-free. */}
                      <div
                        className="h-full rounded-full bg-foreground"
                        style={{ width: `${m.share * 100}%` }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div data-slot="machine-row" className="text-sm text-muted-foreground">
                  — no machine has recorded time this week
                </div>
              )}
            </div>
            <Separator className="my-4" />
            <DeviceName />
            <Separator className="my-4" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Idle timeout</span>
              <Badge variant="secondary" className="tabular-nums">
                {appInfoQ.data ? `${appInfoQ.data.idleTimeoutMin} min` : "—"}
              </Badge>
            </div>
          </div>
        </section>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Press <kbd className="font-mono">d</kbd> to toggle dark mode
        </p>
      </div>
    </div>
  );
}

export default App;
