/**
 * The sanity tick. It READS AND POSTS NOTHING.
 *
 * This is the single most tempting file in the project to get wrong, because
 * the obvious implementation is fatal:
 *
 *   > "Post a null canary and see whether the tap sees it."
 *
 * A posted event — even a null one, even our own, even one nobody sees — RESETS
 * THE SYSTEM IDLE CLOCK. A watchdog that posts every five minutes is an
 * always-on mouse jiggler that the user never asked for and cannot turn off. It
 * would keep the display awake, it would defeat the screensaver, and it would
 * make our own "is anyone here" question unanswerable by any OS API. So there
 * is NO active liveness probe here, and there is a test asserting that not one
 * event-posting function is ever called.
 *
 * ── ONE TIMER, TWO CADENCES ─────────────────────────────────────────────────
 *
 * The tick used to run only every five minutes, and that was the bug that made
 * this app measure nothing. When macOS disables an event tap it does not
 * announce it: measured on the owner's Mac, a blocked callback left the tap
 * disabled and then THREE FULL SECONDS of pumping the run loop produced no
 * disable notice at all — the notice rides along with the next event, and the
 * whole problem is that we can no longer see events. So the tap-disabled
 * callback cannot be the recovery mechanism. Something has to ask, on a clock.
 *
 * Five minutes is far too slow to be that clock. Five minutes of invisible
 * input is a lost session, and it is exactly what the owner saw: every stored
 * interval two to six minutes long, closing `tap_lost`, over and over.
 *
 * So the timer now beats every `livenessMs` (2 s) and does two different jobs:
 *
 *   EVERY BEAT — `source.tapAlive()`, one CoreGraphics boolean. If the tap is
 *     off, `source.reviveTap()` re-arms it, rebuilding the tap if a plain
 *     re-enable is refused. No window has to be open, nothing has to be
 *     focused, and the owner does not have to touch the app.
 *
 *   EVERY `everyMs` (5 min) — the full `source.probe()`: camera, mic, granted
 *     mask, clock re-anchor. That one walks the CoreMediaIO and CoreAudio
 *     device lists, which are synchronous HAL round trips, and it stays at five
 *     minutes precisely because it is the expensive half. Splitting the cheap
 *     read out of the expensive one is what makes a 2-second cadence affordable
 *     at all.
 *
 * ── WHEN AN INTERVAL IS CLOSED, AND WHEN IT IS NOT ──────────────────────────
 *
 * A recovery is NOT a tap loss. If the tap comes back inside one beat we were
 * blind for at most two seconds, and those two seconds happened because events
 * were arriving fast enough to overrun the callback — i.e. the owner was
 * demonstrably at the keyboard. Closing the interval there would shred a real
 * working session into two-minute fragments, which is the symptom this file
 * exists to end. Only an UNRECOVERABLE tap is a `tap_lost`, and it is reported
 * once per outage, on the edge, never once per beat.
 *
 * Note also what is NOT here: any read of `CGEventSourceSecondsSinceLastEventType`,
 * `ioreg HIDIdleTime`, or `powerMonitor.getSystemIdleTime()`. All three are
 * polluted by our own jiggler. AGENTS.md #7.
 */
import type { NativeStatus, TapRevival } from "../native";
import { DEFAULTS } from "../shared/constants";

/**
 * The subset of `SignalSource` a watchdog may touch.
 *
 * Deliberately narrow: `jiggle` and `setKeepAwake` are not in it, so a future
 * edit cannot reach an event-posting function from here without widening this
 * type — which is a visible, reviewable change rather than a silent one.
 */
export interface WatchdogSource {
  probe(): NativeStatus;
  tapAlive(): boolean;
  reviveTap(): TapRevival;
}

export interface WatchdogTarget {
  onWatchdogTick(status: NativeStatus, atMs: number): void;
  /** The tap could not be revived. Closes at the last signal we still trust. */
  onTapLost(atMs: number): void;
  /**
   * The tap was found off and put back, with no user interaction. NOT a tap
   * loss: nothing is closed, because we were blind for at most one beat and the
   * owner was plainly working when it happened.
   */
  onTapRevived(atMs: number, revival: TapRevival): void;
}

export interface WatchdogOptions {
  readonly source: WatchdogSource;
  readonly target: WatchdogTarget;
  /** The full probe. Camera, mic, granted mask. Expensive; stays at 5 minutes. */
  readonly everyMs?: number;
  /** The liveness beat. One boolean. This is the timer's actual period. */
  readonly livenessMs?: number;
  readonly now?: () => number;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
  /** Injected so a dead tap is a log line, not a silent recovery. */
  readonly log?: (message: string) => void;
}

export interface Watchdog {
  start(): void;
  stop(): void;
  /** One beat, synchronously. The timer calls exactly this. */
  tick(): void;
  /** Force the expensive probe now, whatever the clock says. Boot uses it. */
  fullProbe(): NativeStatus;
  readonly ticks: number;
  readonly fullProbes: number;
  readonly tapRevivals: number;
  readonly tapRebuilds: number;
  /** Outages that could not be revived — one per outage, not one per beat. */
  readonly tapLosses: number;
  readonly tapDown: boolean;
}

export function createWatchdog(o: WatchdogOptions): Watchdog {
  const now = o.now ?? Date.now;
  const setRepeating = o.setRepeating ?? setInterval;
  const clearRepeating = o.clearRepeating ?? clearInterval;
  const livenessMs = o.livenessMs ?? DEFAULTS.tapLivenessMs;
  const everyMs = o.everyMs ?? DEFAULTS.watchdogMs;
  const log = o.log ?? (() => undefined);

  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  let fullProbes = 0;
  let tapRevivals = 0;
  let tapRebuilds = 0;
  let tapLosses = 0;
  let tapDown = false;
  let lastFullMs: number | null = null;

  function fullProbe(): NativeStatus {
    fullProbes++;
    lastFullMs = now();
    const status = o.source.probe();
    o.target.onWatchdogTick(status, lastFullMs);
    return status;
  }

  /**
   * The cheap half. Never throws: this runs on a timer, and an exception here
   * would take the interval down with it and leave the app with no watchdog at
   * all — which is how a recoverable tap becomes a permanently dead one.
   */
  function liveness(at: number): void {
    let alive: boolean;
    try {
      alive = o.source.tapAlive();
    } catch (err) {
      log(`watchdog: tapAlive threw — ${String(err)}`);
      alive = false;
    }

    if (alive) {
      if (tapDown) {
        tapDown = false;
        log("watchdog: the tap is answering again");
      }
      return;
    }

    let revival: TapRevival;
    try {
      revival = o.source.reviveTap();
    } catch (err) {
      revival = { outcome: "dead", detail: String(err) };
    }

    switch (revival.outcome) {
      case "healthy":
        // It came back between the two reads. Nothing to report.
        tapDown = false;
        return;
      case "reenabled":
      case "rebuilt": {
        if (revival.outcome === "rebuilt") tapRebuilds++;
        tapRevivals++;
        tapDown = false;
        log(
          `watchdog: the tap was off and has been ${revival.outcome} ` +
            `(${revival.detail}) — no interval was closed`,
        );
        o.target.onTapRevived(at, revival);
        return;
      }
      case "dead": {
        // Report the loss ONCE, on the edge. A beat every two seconds must not
        // become a `tap_lost` row every two seconds; the row says "we stopped
        // being able to see input here", and that is a single fact per outage.
        if (!tapDown) {
          tapDown = true;
          tapLosses++;
          log(`watchdog: the tap is dead and will not come back — ${revival.detail}`);
          o.target.onTapLost(at);
        }
        return;
      }
    }
  }

  function tick(): void {
    ticks++;
    const at = now();
    liveness(at);
    if (lastFullMs === null || at - lastFullMs >= everyMs) fullProbe();
  }

  return {
    tick,
    fullProbe,
    get ticks() {
      return ticks;
    },
    get fullProbes() {
      return fullProbes;
    },
    get tapRevivals() {
      return tapRevivals;
    },
    get tapRebuilds() {
      return tapRebuilds;
    },
    get tapLosses() {
      return tapLosses;
    },
    get tapDown() {
      return tapDown;
    },
    start() {
      if (timer !== null) return;
      timer = setRepeating(tick, livenessMs);
    },
    stop() {
      if (timer === null) return;
      clearRepeating(timer);
      timer = null;
    },
  };
}
