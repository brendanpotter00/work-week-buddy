/**
 * The 5-minute sanity tick. It READS THREE INTEGERS AND POSTS NOTHING.
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
 * What it does instead is entirely passive:
 *
 *   1. `source.probe()` — tap-enabled, camera-in-use, mic-in-use, plus the
 *      granted mask. Reads, no writes.
 *   2. Hand the status to the runtime, which re-reads the mask so a permission
 *      REVOKED in System Settings becomes a loud degraded state within one tick
 *      rather than a number that quietly runs low forever. M5 gate (c).
 *   3. If the tap is dead: rebuild it and tell the runtime, which closes the
 *      interval at the last signal it still trusts. Rebuilding is a restart of
 *      our own tap, not an event post.
 *
 * Note also what is NOT here: any read of `CGEventSourceSecondsSinceLastEventType`,
 * `ioreg HIDIdleTime`, or `powerMonitor.getSystemIdleTime()`. All three are
 * polluted by our own jiggler. AGENTS.md #7.
 */
import type { NativeStatus } from "../native";
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
  restart(): NativeStatus;
}

export interface WatchdogTarget {
  onWatchdogTick(status: NativeStatus, atMs: number): void;
  onTapLost(atMs: number): void;
}

export interface WatchdogOptions {
  readonly source: WatchdogSource;
  readonly target: WatchdogTarget;
  readonly everyMs?: number;
  readonly now?: () => number;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
}

export interface Watchdog {
  start(): void;
  stop(): void;
  /** One tick, synchronously. The timer calls exactly this. */
  tick(): NativeStatus;
  readonly ticks: number;
  readonly tapRestarts: number;
}

export function createWatchdog(o: WatchdogOptions): Watchdog {
  const now = o.now ?? Date.now;
  const setRepeating = o.setRepeating ?? setInterval;
  const clearRepeating = o.clearRepeating ?? clearInterval;
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  let tapRestarts = 0;

  function tick(): NativeStatus {
    ticks++;
    const at = now();
    let status = o.source.probe();

    if (status.tapInstalled && !status.tapEnabled) {
      // The tap died. We may have silently missed input, so the runtime closes
      // the interval at the last signal it still trusts — inventing the missing
      // minutes would be the same bug as ending at `now()`.
      tapRestarts++;
      o.target.onTapLost(at);
      status = o.source.restart();
    }

    o.target.onWatchdogTick(status, at);
    return status;
  }

  return {
    tick,
    get ticks() {
      return ticks;
    },
    get tapRestarts() {
      return tapRestarts;
    },
    start() {
      if (timer !== null) return;
      timer = setRepeating(tick, o.everyMs ?? DEFAULTS.watchdogMs);
    },
    stop() {
      if (timer === null) return;
      clearRepeating(timer);
      timer = null;
    },
  };
}
