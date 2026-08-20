/**
 * THE MAIN THREAD IS THE APP, AND IT MUST NEVER GO QUIET.
 *
 * Twice now this app has shipped a launch that froze: once on a TCC consent
 * dialog inside `readdirSync`, once on a Keychain dialog inside
 * `safeStorage.decryptString()`. Both were synchronous macOS calls that block
 * the calling thread until a human answers something, and both ran on the boot
 * path. A blocked main thread is not a slow app — it is a dead event loop: no
 * window can open, the tray stops advancing, `second-instance` never fires and
 * NOT ONE LINE CAN BE LOGGED, because logging is code and code does not run.
 *
 * The class is what matters, not the two examples. macOS has a whole family of
 * these — Keychain, TCC, Gatekeeper, a network volume, a FileProvider that has
 * gone away — and the next one will be a call nobody on this project has
 * thought about yet.
 *
 * So: a timer that expects to be woken every second, and complains about the
 * gap. It cannot log DURING a freeze. It logs the moment the freeze ends, with
 * the duration and the step the app was on, which turns "it seemed to hang for
 * a while" into a line naming a number. For a freeze that never ends, the boot
 * breadcrumbs in `wwb.log` still stop at the call that did it — that half is
 * `log.boot()`'s job, and the two together are the whole diagnosis.
 */
import { log } from "./log";

/** Woken this often. Cheap enough to leave running for the life of the app. */
const TICK_MS = 1_000;

/**
 * Below this, a gap is ordinary: a GC pause, a slow frame, a laptop lid.
 * Above it, something synchronous held the thread and the owner saw a beachball
 * or nothing at all.
 */
export const STALL_MS = 2_000;

export interface StallWatchOptions {
  readonly tickMs?: number;
  readonly stallMs?: number;
  readonly now?: () => number;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
  /** Defaults to a `log.error`. Injected so the rule is testable. */
  readonly onStall?: (stalledMs: number, during: string) => void;
}

export interface StallWatch {
  /**
   * What the app is doing, for the next complaint to name.
   *
   * Set at each boot step and then left at "running". A stall reported during
   * "opening the database" is a different bug from one during "running", and
   * the difference is the first thing anybody would ask.
   */
  mark(what: string): void;
  stop(): void;
  /** The worst gap seen so far, in ms. Read by the smoke run. */
  worstMs(): number;
}

/**
 * Starts watching. Never throws, and never keeps the process alive on its own.
 */
export function watchMainThread(opts: StallWatchOptions = {}): StallWatch {
  const tickMs = opts.tickMs ?? TICK_MS;
  const stallMs = opts.stallMs ?? STALL_MS;
  const now = opts.now ?? Date.now;
  const setRepeating = opts.setRepeating ?? setInterval;
  const clearRepeating = opts.clearRepeating ?? clearInterval;
  const onStall =
    opts.onStall ??
    ((stalled: number, during: string): void => {
      log.error(
        `the main thread was blocked for ${String(stalled)}ms during "${during}" — ` +
          `something synchronous held it. On macOS that is usually a call that puts a ` +
          `dialog on screen (Keychain, TCC) or touches a volume that is not answering. ` +
          `Nothing else in the app ran for that long: no window, no tray, no IPC.`,
      );
    });

  let last = now();
  let worst = 0;
  let during = "boot";

  const timer = setRepeating(() => {
    const at = now();
    const gap = at - last - tickMs;
    last = at;
    if (gap <= 0) return;
    worst = Math.max(worst, gap);
    if (gap >= stallMs) onStall(Math.round(gap), during);
  }, tickMs);
  // A diagnostic must never be the reason the process stays alive.
  timer.unref?.();

  return {
    mark(what: string): void {
      during = what;
      // Re-baseline: the gap belongs to the step that was running when it
      // happened, and a step boundary is exactly where that changes.
      last = now();
    },
    stop(): void {
      clearRepeating(timer);
    },
    worstMs(): number {
      return Math.round(worst);
    },
  };
}
