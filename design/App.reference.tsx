import * as React from "react"
import { ActivityCalendar, type Activity } from "react-activity-calendar"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import {
  Monitor,
  Moon,
  Sun,
  Laptop,
  Coffee,
  MousePointer2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"
import { makeMockDays, MACHINES } from "@/data"

const days = makeMockDays()

function levelFor(h: number) {
  if (h <= 0) return 0
  if (h < 2) return 1
  if (h < 5) return 2
  if (h < 8) return 3
  return 4
}

const activities: Activity[] = days.map((d) => ({
  date: d.date,
  count: Math.round(d.hours * 10) / 10,
  level: levelFor(d.hours),
}))

const weekBars = [
  { day: "Mon", hours: 7.8 },
  { day: "Tue", hours: 8.6 },
  { day: "Wed", hours: 6.1 },
  { day: "Thu", hours: 9.2 },
  { day: "Fri", hours: 4.3 },
  { day: "Sat", hours: 0 },
  { day: "Sun", hours: 0.5 },
]

const chartConfig = {
  hours: { label: "Hours", color: "var(--foreground)" },
} satisfies ChartConfig

function StatCard({
  label,
  value,
  unit,
  sub,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-heading text-[28px] leading-none font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        {unit ? (
          <span className="text-sm text-muted-foreground">{unit}</span>
        ) : null}
      </div>
      {sub ? (
        <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
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
  )
}

export function App() {
  const [jiggler, setJiggler] = React.useState(true)
  const [caffeinate, setCaffeinate] = React.useState(false)

  return (
    <div className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-8 py-10">
        {/* Header */}
        <header className="flex items-start justify-between">
          <div>
            <h1 className="font-heading text-[22px] leading-tight font-semibold tracking-tight">
              Work Week Tracker
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Wednesday, August 19 &middot; week 34
            </p>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        {/* Live status strip */}
        <section className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40" />
            <span className="relative inline-flex size-2 rounded-full bg-foreground" />
          </span>
          <span className="text-sm font-medium">Working</span>
          <span className="font-mono text-sm text-muted-foreground tabular-nums">
            2h 41m
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Laptop className="size-3.5" />
            Work laptop
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="text-sm text-muted-foreground">
            last signal <span className="tabular-nums">12s</span> ago
          </span>
          <div className="ml-auto flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <MousePointer2 className="size-3.5" />
              Jiggler
              <Switch checked={jiggler} onCheckedChange={setJiggler} />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Coffee className="size-3.5" />
              Caffeinate
              <Switch checked={caffeinate} onCheckedChange={setCaffeinate} />
            </label>
          </div>
        </section>

        {/* Stat row */}
        <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="This week"
            value="36.5"
            unit="h"
            sub="+4.2h vs last week"
          />
          <StatCard
            label="Avg interval · week"
            value="1h 52m"
            sub="20 intervals"
          />
          <StatCard
            label="Avg interval · all time"
            value="1h 38m"
            sub="1,284 intervals"
          />
          <StatCard
            label="Longest interval"
            value="6h 12m"
            sub="Mar 4, 2026 · Work laptop"
          />
        </section>

        {/* Heatmap */}
        <section className="mt-4 rounded-lg border border-border bg-card px-5 py-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-sm font-medium">Daily hours</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              2,614 h tracked since Aug 2025
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <ActivityCalendar
              data={activities}
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
              tooltips={{
                activity: {
                  text: (a) => `${a.count} h on ${a.date}`,
                },
              }}
            />
          </div>
        </section>

        {/* Bottom split */}
        <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-lg border border-border bg-card px-5 py-5">
            <h2 className="font-heading text-sm font-medium">This week</h2>
            <ChartContainer
              config={chartConfig}
              className="mt-4 h-[180px] w-full"
            >
              <BarChart data={weekBars} margin={{ left: 0, right: 0, top: 4 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.35} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="hours"
                  fill="var(--color-hours)"
                  radius={3}
                  maxBarSize={34}
                />
              </BarChart>
            </ChartContainer>
          </div>

          <div className="rounded-lg border border-border bg-card px-5 py-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-medium">By machine</h2>
              <span className="text-xs text-muted-foreground">this week</span>
            </div>
            <div className="mt-4 flex flex-col gap-3.5">
              {MACHINES.map((m) => (
                <div key={m.id}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Monitor className="size-3.5 text-muted-foreground" />
                      {m.label}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {m.hours}h
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-foreground"
                      style={{ width: `${m.share * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <Separator className="my-4" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Idle timeout</span>
              <Badge variant="secondary" className="tabular-nums">
                15 min
              </Badge>
            </div>
          </div>
        </section>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Press <kbd className="font-mono">d</kbd> to toggle dark mode
        </p>
      </div>
    </div>
  )
}

export default App
