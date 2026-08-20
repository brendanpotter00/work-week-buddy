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
import { Coffee, Laptop, Monitor, Moon, MousePointer2, Sun } from "lucide-react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { DeviceName } from "@/renderer/components/device-name";
import { LiveStopwatch } from "@/renderer/components/live-stopwatch";
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
import { useAppInfo, useLiveStatus, useMetrics, useNowMs, useToggles } from "@/renderer/lib/ipc";
import { useResolvedTheme } from "@/renderer/lib/use-resolved-theme";
import { useThemeMirror } from "@/renderer/lib/use-theme-mirror";
import { DEFAULT_METRICS_POLICY, type DegradedReason } from "@/shared/ipc-types";
import {
  creditedOpenMs,
  formatAgo,
  formatCount,
  formatDuration,
  formatHeaderDate,
  formatHours,
  formatWeekDelta,
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
};

function StatCard({
  label,
  value,
  unit,
  sub,
  warn = false,
}: {
  label: string;
  /** `null` renders '—'. A real 0 renders '0'. They are different things. */
  value: string | null;
  unit?: string;
  sub?: string | null;
  warn?: boolean;
}): React.ReactElement {
  return (
    <div data-slot="stat-card" className="rounded-lg border border-border bg-card px-4 py-3.5">
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

const STATE_LABEL = { working: "Working", idle: "Idle", paused: "Paused" } as const;

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

  const working = status?.state === "working";
  const openMs = status ? creditedOpenMs(status, nowMs) : 0;
  const degraded = status?.degraded ?? [];
  const keyboardBroken = degraded.includes("keyboard_permission_missing");

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
      <div className="mx-auto w-full max-w-[1100px] px-8 py-10">
        {/* Header. `titleBarStyle: "hiddenInset"` leaves no draggable chrome,
            so the header is the drag region — and the buttons opt back out. */}
        <header className="flex items-start justify-between [-webkit-app-region:drag]">
          <div>
            <h1 className="font-heading text-[22px] leading-tight font-semibold tracking-tight">
              Work Week Buddy
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{formatHeaderDate(nowMs)}</p>
          </div>
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <ThemeToggle />
          </div>
        </header>

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

        {/* The headline: how long this session has been running, and how much
            of today is already banked. `metrics.policy` rather than the
            settings pane, so the caveat the stopwatch shows and the numbers the
            stat cards show were computed under the same policy. */}
        <LiveStopwatch
          status={status ?? null}
          policy={metrics?.policy ?? DEFAULT_METRICS_POLICY}
          nowMs={nowMs}
        />

        {/* Live status strip */}
        <section className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <span className="relative flex size-2">
            {/* A pulsing dot while idle is a lie. §5.6. */}
            {working ? (
              <span
                data-slot="ping"
                className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40"
              />
            ) : null}
            <span
              className={`relative inline-flex size-2 rounded-full ${
                working ? "bg-foreground" : "bg-muted-foreground/40"
              }`}
            />
          </span>
          <span className="text-sm font-medium">
            {status ? STATE_LABEL[status.state] : "Idle"}
          </span>
          <span className="font-mono text-sm text-muted-foreground tabular-nums">
            {formatDuration(openMs)}
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Laptop className="size-3.5" />
            {status?.machineLabel || "this Mac"}
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="text-sm text-muted-foreground">
            last signal{" "}
            <span className="tabular-nums">
              {status?.lastSignalMs == null ? "—" : formatAgo(nowMs - status.lastSignalMs)}
            </span>{" "}
            ago
          </span>
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

        {/* Stat row */}
        <section
          data-slot="stat-row"
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <StatCard
            label="This week"
            value={metrics ? formatHours(metrics.week.hours) : null}
            unit="h"
            sub={metrics ? formatWeekDelta(metrics.week.hours, metrics.week.prevHours) : null}
            warn={keyboardBroken}
          />
          <StatCard
            label="Avg interval · week"
            value={
              metrics?.interval.avgMin != null
                ? formatDuration(metrics.interval.avgMin * 60_000)
                : null
            }
            sub={metrics ? `${formatCount(metrics.interval.nIntervals)} intervals` : null}
          />
          <StatCard
            label="Avg interval · all time"
            value={
              metrics?.allTime.avgMin != null
                ? formatDuration(metrics.allTime.avgMin * 60_000)
                : null
            }
            sub={metrics ? `${formatCount(metrics.allTime.nIntervals)} intervals` : null}
          />
          <StatCard
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

        {/* Heatmap */}
        <section className="mt-4 rounded-lg border border-border bg-card px-5 py-5">
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
