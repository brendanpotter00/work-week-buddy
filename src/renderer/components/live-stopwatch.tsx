/**
 * The live stopwatch — "how long have I been working?", answered at a glance.
 *
 * Presentation only. Every decision about WHAT the number means lives in
 * `src/shared/stopwatch.ts`, which the tray imports too, so the menu bar and
 * this card cannot disagree about the session that is open right now.
 *
 * WHY THE DIGITS ARE ALLOWED TO TICK ONCE A SECOND HERE
 *
 * The per-second ban in `docs/IMPL_UI.md` is about the MENU-BAR TITLE, where a
 * changing string reflows every icon to its left once a second. A pixel inside
 * our own window costs nothing, and a stopwatch that moved once a minute would
 * not read as running at all. Nothing on this path is scheduled from
 * `deadlineMs` (`ipc-types.ts` forbids it) and nothing accumulates: every frame
 * recomputes from the absolute epoch ms the snapshot carries, so a renderer
 * whose timer collapsed while hidden (`AGENTS.md` trap #10) shows a stale frame
 * and never a wrong number.
 *
 * WHY THERE ARE TWO NUMBERS AND NOT ONE
 *
 * "This session" and "today" are the two questions a glance asks, and answering
 * only one of them sends the reader to another window. They are computed
 * differently on purpose: the digits are `liveSessionMs()`, a wall clock, while
 * Today is an HOURS figure built on `creditedOpenMs()`, which ends at the last
 * real signal because that is what the close rule will write. They are allowed
 * to differ; conflating them would put `now()` into an hours number, which
 * AGENTS.md says outranks everything.
 */
import * as React from "react";
import { Camera, Mic, MousePointer2, Pause } from "lucide-react";

import { formatHours, formatStopwatch, hoursToday, openIntervalCounts } from "@/shared/format";
import { stopwatchView, type StopwatchTone } from "@/shared/stopwatch";
import type { LiveStatus, MetricsPolicy } from "@/shared/ipc-types";

/** Muted digits are how "this number needs a caveat" reads without a legend. */
const DIGIT_TONE: Record<StopwatchTone, string> = {
  running: "text-foreground",
  held: "text-foreground",
  capped: "text-muted-foreground",
  uncounted: "text-muted-foreground",
  degraded: "text-muted-foreground",
  paused: "text-muted-foreground",
  idle: "text-muted-foreground",
};

function ToneIcon({
  tone,
  held,
}: {
  tone: StopwatchTone;
  held: LiveStatus["heldOpenBy"];
}): React.ReactElement | null {
  const cls = "size-3.5";
  if (tone === "paused") return <Pause className={cls} aria-hidden />;
  if (tone === "uncounted") return <MousePointer2 className={cls} aria-hidden />;
  if (held === "camera") return <Camera className={cls} aria-hidden />;
  if (held === "mic") return <Mic className={cls} aria-hidden />;
  return null;
}

export function LiveStopwatch({
  status,
  policy,
  nowMs,
}: {
  status: LiveStatus | null;
  policy: Pick<MetricsPolicy, "countJigglerTime" | "minIntervalS">;
  nowMs: number;
}): React.ReactElement {
  const view = stopwatchView(status, policy, nowMs);
  const today = status ? hoursToday(status, policy, nowMs) : null;
  // The open session is not always part of Today: the jiggler discards it, and
  // so does the stray-bump floor for the first ninety seconds. Saying which is
  // cheaper than explaining later why two numbers disagree.
  const todayIncludesOpen = status !== null && openIntervalCounts(status, policy, nowMs);

  return (
    <section
      data-slot="stopwatch"
      data-tone={view.tone}
      aria-label="Current session"
      className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-lg border border-border bg-card px-6 py-5"
    >
      <div>
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {/* A pulsing dot while the number needs a caveat is a lie (§5.6), so
              it is tied to `confident` rather than to a session existing. */}
          <span className="relative flex size-2">
            {view.confident ? (
              <span
                data-slot="stopwatch-ping"
                className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40"
              />
            ) : null}
            <span
              className={`relative inline-flex size-2 rounded-full ${
                view.confident ? "bg-foreground" : "bg-muted-foreground/40"
              }`}
            />
          </span>
          <ToneIcon tone={view.tone} held={status?.heldOpenBy ?? null} />
          <span data-slot="stopwatch-label">{view.label}</span>
          {view.warn ? (
            <span
              className="text-destructive"
              title="This number is incomplete — see the banner above"
            >
              ⚠︎
            </span>
          ) : null}
        </div>
        {/* `tabular-nums` is not optional: without it the whole line shudders
            sideways every second as glyph widths change. */}
        <div
          data-slot="stopwatch-digits"
          className={`font-heading mt-2 text-[52px] leading-none font-semibold tracking-tight tabular-nums ${
            DIGIT_TONE[view.tone]
          }`}
        >
          {view.ms === null ? "—" : formatStopwatch(view.ms)}
        </div>
        <div data-slot="stopwatch-note" className="mt-2 text-xs text-muted-foreground">
          {view.note}
        </div>
      </div>

      <div data-slot="stopwatch-today" className="text-right">
        <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          Today
        </div>
        <div className="font-heading mt-2 flex items-baseline justify-end gap-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums">
          {formatHours(today)}
          <span className="text-sm font-normal text-muted-foreground">h</span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {todayIncludesOpen ? "including this session" : "closed sessions only"}
        </div>
      </div>
    </section>
  );
}

export default LiveStopwatch;
