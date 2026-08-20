/**
 * The live stopwatch — "how long have I been working?", answered at a glance.
 *
 * It has no start button and no stop button. The interval machine in main
 * decides when a session is open; this only ever renders that decision.
 *
 * WHY THE DIGITS ARE ALLOWED TO TICK ONCE A SECOND HERE
 *
 * The per-second ban in `docs/IMPL_UI.md` is about the MENU-BAR TITLE, where a
 * changing string reflows every icon to its left once a second. A pixel inside
 * our own window costs nothing, and a stopwatch that moved once a minute would
 * not read as running at all. Nothing on this path is scheduled from
 * `deadlineMs` (`ipc-types.ts` forbids it) and nothing accumulates: every frame
 * recomputes from the absolute epoch ms the snapshot carries, so a renderer
 * whose timer collapsed while hidden (`AGENTS.md` trap #10) shows a stale
 * frame and never a wrong number.
 *
 * WHY THERE ARE TWO NUMBERS AND NOT ONE
 *
 * `liveSessionMs()` is a wall clock — how long the session has been open. It is
 * the only thing the digits show. `hoursToday()` is an HOURS figure and is
 * built on `creditedOpenMs()`, which ends at the last real signal because that
 * is what the close rule will write. They are different questions and they are
 * allowed to differ; conflating them would put `now()` into an hours number,
 * which is the one thing AGENTS.md says outranks everything.
 *
 * WHAT THE STOPWATCH REFUSES TO DO
 *
 * Run confidently when the number is going to be thrown away or is already
 * known to be wrong. Four cases, each with its own tone and its own sentence:
 *
 *  - a camera/mic hold has a cap (PRD §3.4) — the clock STOPS at it rather than
 *    counting a forgotten Zoom call all night;
 *  - the jiggler is on and `countJigglerTime` is 0 — this time will not survive
 *    `v_countable`, so racing digits would be a lie. They go muted and say so;
 *  - a degraded reason is live — the banner above already says the numbers are
 *    incomplete, and this one wears the same ⚠︎ the stat cards wear;
 *  - paused or idle — there is nothing running, so nothing renders as running.
 */
import * as React from "react";
import { Camera, Mic, MousePointer2, Pause } from "lucide-react";

import {
  formatHours,
  formatStopwatch,
  hoursToday,
  isHoldCapped,
  liveSessionMs,
  openIntervalCounts,
} from "@/shared/format";
import type { LiveStatus, MetricsPolicy } from "@/shared/ipc-types";

/**
 * One visual treatment per honest state. `running` is the ONLY one that looks
 * like a confident clock; every other value is a deliberate signal that the
 * number in front of you needs a caveat.
 */
export type StopwatchTone =
  | "running"
  | "held"
  | "capped"
  | "uncounted"
  | "degraded"
  | "paused"
  | "idle";

export interface StopwatchView {
  /** ms on the clock; `null` when no session is open — renders '—', never '0:00:00' */
  ms: number | null;
  /** whether these digits move on the next 1 Hz tick */
  ticking: boolean;
  tone: StopwatchTone;
  label: string;
  /** why the number is what it is, in words. Always present. */
  note: string;
  /** the ⚠︎ the stat cards use for a number the banner has already spoiled */
  warn: boolean;
}

const HOLD_NOUN: Record<"camera" | "mic", string> = {
  camera: "camera",
  mic: "meeting mic",
};

/**
 * The whole state machine, as a pure function, so every branch is testable
 * without a DOM. Precedence is deliberate and runs most-alarming first: a
 * paused tracker outranks a jiggler caveat, which outranks a camera hold,
 * because the reader needs the reason the number is NOT what they expect.
 */
export function stopwatchView(
  status: LiveStatus | null,
  policy: Pick<MetricsPolicy, "countJigglerTime" | "minIntervalS">,
  nowMs: number,
): StopwatchView {
  if (status === null) {
    return { ms: null, ticking: false, tone: "idle", label: "—", note: " ", warn: false };
  }

  if (status.state === "paused") {
    // `pauseOn` closes the open interval (`reduce.ts`), so this is normally a
    // dash. The frozen clock below is the defensive half: `asOfMs` is the
    // snapshot's own timestamp, so even a paused status that still carried an
    // open interval could not advance on a display tick.
    return {
      ms: status.openedAtMs === null ? null : liveSessionMs(status, status.asOfMs),
      ticking: false,
      tone: "paused",
      label: "Paused",
      note: "Tracking is paused — nothing is being recorded.",
      warn: false,
    };
  }

  if (status.openedAtMs === null) {
    return {
      ms: null,
      ticking: false,
      tone: "idle",
      label: "Idle",
      note:
        status.lastSignalMs === null
          ? "No session open yet — the clock starts on your first keystroke."
          : "No session open — the clock restarts on your next keystroke.",
      warn: false,
    };
  }

  const ms = liveSessionMs(status, nowMs);
  const capped = isHoldCapped(status, nowMs);
  const held = status.heldOpenBy;

  if (status.degraded.length > 0) {
    return {
      ms,
      ticking: !capped,
      tone: "degraded",
      label: "Working",
      // Deliberately not a number-shaped reassurance: the banner above names
      // the reason, and this says only that the reason applies here too.
      note: "This session is being measured with a broken signal — see above.",
      warn: true,
    };
  }

  if (!openIntervalCounts(status, policy, nowMs)) {
    // Under the stray-bump floor is the ordinary first-90-seconds case and is
    // not worth a caveat; the jiggler is, because the time is being discarded
    // on purpose and the user is the one who asked for that.
    if (status.jigglerOnForOpenInterval && policy.countJigglerTime === 0) {
      return {
        ms,
        ticking: !capped,
        tone: "uncounted",
        label: "Not counted",
        note: "The jiggler is on, so this session will not count toward your hours.",
        warn: false,
      };
    }
  }

  if (capped && held !== null) {
    return {
      ms,
      ticking: false,
      tone: "capped",
      label: "Working",
      note: `Stopped at the ${HOLD_NOUN[held]} cap — it will not count past this.`,
      warn: false,
    };
  }

  if (held !== null) {
    return {
      ms,
      ticking: true,
      tone: "held",
      label: "Working",
      note: `Held open by the ${HOLD_NOUN[held]}, capped at ${formatStopwatch(
        (status.heldUntilMs ?? status.openedAtMs) - status.openedAtMs,
      )}.`,
      warn: false,
    };
  }

  return {
    ms,
    ticking: true,
    tone: "running",
    label: "Working",
    note: `Started at ${new Date(status.openedAtMs).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}.`,
    warn: false,
  };
}

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

function ToneIcon({ tone }: { tone: StopwatchTone }): React.ReactElement | null {
  const cls = "size-3.5";
  if (tone === "paused") return <Pause className={cls} />;
  if (tone === "uncounted") return <MousePointer2 className={cls} />;
  if (tone === "capped" || tone === "held") return null;
  return null;
}

function HoldIcon({ held }: { held: LiveStatus["heldOpenBy"] }): React.ReactElement | null {
  if (held === "camera") return <Camera className="size-3.5" />;
  if (held === "mic") return <Mic className="size-3.5" />;
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

  return (
    <section
      data-slot="stopwatch"
      data-tone={view.tone}
      className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-lg border border-border bg-card px-6 py-5"
    >
      <div>
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {/* A pulsing dot while nothing is running is a lie (§5.6), so it is
              tied to `ticking` rather than to the presence of a session. */}
          <span className="relative flex size-2">
            {view.ticking ? (
              <span
                data-slot="stopwatch-ping"
                className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40"
              />
            ) : null}
            <span
              className={`relative inline-flex size-2 rounded-full ${
                view.ticking ? "bg-foreground" : "bg-muted-foreground/40"
              }`}
            />
          </span>
          <ToneIcon tone={view.tone} />
          <HoldIcon held={status?.heldOpenBy ?? null} />
          {view.label}
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

      {/* "This session" and "today" are the two questions a glance asks, so
          they sit side by side and neither needs the other window. */}
      <div data-slot="stopwatch-today" className="text-right">
        <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          Today
        </div>
        <div className="font-heading mt-2 flex items-baseline justify-end gap-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums">
          {formatHours(today)}
          <span className="text-sm font-normal text-muted-foreground">h</span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">counted so far</div>
      </div>
    </section>
  );
}

export default LiveStopwatch;
