/**
 * The single lazy countdown.
 *
 * Lives in main, never in the renderer: a hidden renderer's timers collapse —
 * measured 153 of 400 ticks with a clean 60-second gap. AGENTS.md #10.
 *
 * It owns a real timer, so it is not in src/core/. It decides nothing: it calls
 * `fire(now)` and the reducer works out close-vs-re-arm. That separation is why
 * "the deadline fired four hours late" is a one-line test.
 */

type Fire = (firedAtMs: number) => void;

export interface Deadline {
  arm(atMs: number): void;
  cancel(): void;
  /** Test seam. Production passes the real clock and setTimeout. */
  readonly armedFor: number | null;
}

/** A delay past ~24.8 days overflows to firing immediately, forever. Six hours
 *  also forces a re-evaluation shortly after a long sleep rather than trusting
 *  a stale timer. */
export const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

export function createDeadline(
  fire: Fire,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout = setTimeout,
  unschedule: (t: NodeJS.Timeout) => void = clearTimeout,
): Deadline {
  let timer: NodeJS.Timeout | null = null;
  let target: number | null = null;

  const clear = () => {
    if (timer) {
      unschedule(timer);
      timer = null;
    }
    target = null;
  };

  return {
    get armedFor() {
      return target;
    },
    cancel: clear,
    arm(atMs: number) {
      // LAZY: if a timer is already pending for at or after this moment, leave
      // it. Firing early is free — the reducer recomputes and re-arms. This is
      // what turns a 300-events/second mouse drag into zero timer syscalls.
      if (timer !== null && target !== null && target <= atMs) return;
      clear();
      target = atMs;
      // Clamp: setTimeout with a huge or negative delay is unreliable.
      const delay = Math.min(Math.max(0, atMs - now()), MAX_DELAY_MS);
      timer = schedule(() => {
        timer = null;
        target = null;
        // The REAL wall-clock time, not the instant we were armed for. After a
        // three-hour lid-close these differ by three hours, and the reducer
        // needs the truth to close at the pre-sleep signal.
        fire(now());
      }, delay);
    },
  };
}
