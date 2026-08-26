/**
 * "The jiggle moves nothing on screen", measured on a Mac somebody is using.
 *
 * ── THE PROMISE THIS CHECK GUARDS ───────────────────────────────────────────
 * The jiggler posts `kCGEventNull` precisely because that event type carries no
 * coordinates and therefore CANNOT move the cursor (docs/MACOS.md §3, PRD §3.6).
 * "No cursor drift, no accidental drags, nothing fighting the pointer" is a
 * product promise, so something has to keep proving it. This is that something.
 *
 * ── WHY IT NEEDED REBUILDING ────────────────────────────────────────────────
 * The first version read the cursor before the post and again after it, and
 * failed if the two differed. That is a correct measurement of an idle machine
 * and a coin flip on a used one — a human with a hand on the trackpad moves the
 * cursor inside the window, and the check reports the jiggler moved it.
 *
 * Measured on the owner's Mac, twice, on the ONE path where a human is
 * guaranteed to be at the keyboard — `scripts/install.sh` running `--selftest`
 * immediately after the install:
 *
 *   FAIL cursor did not move · -974.13671875,495.265625 → -974.37890625,495.265625
 *   FAIL cursor did not move · -1293.9921875,826.9453125 → -1271.59375,816.27734375
 *
 * A quarter of a pixel in the first one. Both runs passed every check that
 * actually discriminates — the tagged jiggle round-tripped as ours, userData and
 * srcPid both read as numbers, the posted event was `kCGEventNull`. Nothing was
 * wrong with the app. The gate refused the install anyway and left the tracker
 * not running, and the only way through it was to bypass it by hand.
 *
 * **A safety gate that fails during normal use trains its owner to bypass it**,
 * which is strictly worse than not having the gate at all. So the check stays —
 * deleting it would give up a real promise — and instead it learns to tell "the
 * jiggler moved the cursor" apart from "a person moved the cursor".
 *
 * ── WHAT MAKES THAT POSSIBLE ────────────────────────────────────────────────
 * The tap already classifies every event, and our own tagged jiggle returns at
 * the `isOurs` branch BEFORE anything is counted. So a foreign pointer event
 * reaching the counter is, by construction, input we did not generate. That
 * gives an honest three-way answer instead of a boolean:
 *
 *   the cursor moved, and no foreign pointer event arrived  → OUR fault. FAIL.
 *   the cursor held still, and no foreign pointer event      → proven. PASS.
 *   a foreign pointer event landed in the window             → VOID. Measure again.
 *   every attempt was void                                   → could not measure.
 *
 * The last state is the point. It is not a pass and it is not a failure: it does
 * not fail the install, and it does not report green either.
 *
 * Four things keep the void case rare rather than routine:
 *
 *   1. **Wait for a gap.** Nobody moves a mouse continuously for seconds on end.
 *      Each attempt first waits for the pointer counter to go flat, which costs
 *      nothing on an idle machine and finds the pause on a busy one.
 *   2. **Keep the window small.** The old window spanned the whole round-trip
 *      race, up to two seconds. This one is the post plus its round trip — a
 *      couple of milliseconds in practice.
 *   3. **Ignore the keyboard.** A keystroke cannot move a cursor, so typing must
 *      not void a cursor measurement. Only non-keyboard input counts, which
 *      matters because the human running `install.sh` has their hands on the
 *      keyboard by definition.
 *   4. **Retry.** A void attempt is a measurement that did not happen, not an
 *      answer, so it is simply taken again.
 *
 * ── WHY THIS IS NOT A WEAKENED CHECK ────────────────────────────────────────
 * A jiggler that really does move the cursor moves it on EVERY post, and — this
 * is the load-bearing part — its own event never reaches the pointer counter,
 * because `isOurs` returns first. So a genuine regression produces clean windows
 * with movement in them and fails, exactly as before. There is no arrangement of
 * human input that turns a real regression into a pass: contamination can only
 * cost an attempt, and only "could not measure" survives running out of them.
 *
 * ── NO KOFFI, NO ELECTRON, NO CLOCK ─────────────────────────────────────────
 * Everything macOS-shaped arrives through `StillnessProbe`, so this file is the
 * one part of the self-test that CAN be honestly tested: the fake probe in
 * test/native/cursor-stillness.test.ts drives a human who never stops moving, a
 * jiggler that drags the cursor a pixel, and every combination in between. The
 * waits are counted in polls rather than read off a clock, which is what makes
 * those tests arithmetic instead of sleeps.
 */
import type { SelfTestCheck } from "./types";

export interface CursorPoint {
  readonly x: number;
  readonly y: number;
}

/** What one post did, from the tap's point of view. */
export interface PostOutcome {
  /** False means nothing was posted at all — no Accessibility grant. */
  readonly posted: boolean;
  /**
   * The posted event came back through our own tap.
   *
   * Without it we do not know the WindowServer has finished with the event, so
   * "the cursor is where it was" is not yet evidence of anything and the
   * attempt is void.
   */
  readonly roundTripped: boolean;
}

/**
 * The macOS surface this measurement needs, and nothing else.
 *
 * Deliberately four reads and one action: everything here is either a
 * CoreGraphics call or a counter that the tap callback owns.
 */
export interface StillnessProbe {
  /** Where the cursor is right now, in the WindowServer's global coordinates. */
  cursor(): CursorPoint;
  /**
   * Monotone count of REAL, NON-KEYBOARD events the tap has seen.
   *
   * Our own tagged jiggle is never in here — the callback returns at the
   * `isOurs` branch, above the line that increments it. Neither is a keystroke,
   * which cannot move a cursor. So a change in this number across the window
   * means a pointer moved that we did not move.
   */
  pointerEvents(): number;
  /**
   * Is the tap armed? While it is not, `pointerEvents()` is blind, and a flat
   * counter says nothing about whether anybody was moving the mouse.
   */
  tapAlive(): boolean;
  /** Post one tagged jiggle and wait for it to come back through the tap. */
  postAndSettle(): Promise<PostOutcome>;
  sleep(ms: number): Promise<void>;
}

export type StillnessVerdict =
  /** The cursor held still across a window nothing else was touching. */
  | "still"
  /** The cursor moved across a window nothing else was touching. Our fault. */
  | "moved"
  /** Every attempt was contaminated. Neither a pass nor a failure. */
  | "inconclusive"
  /** Nothing was posted, so there was nothing to measure. */
  | "not-posted";

/** Why one attempt did not count. Empty string means it did. */
export type VoidReason =
  | ""
  | "foreign pointer input"
  | "tap not alive"
  | "no round trip"
  | "cursor unreadable";

export interface StillnessAttempt {
  readonly from: CursorPoint;
  readonly to: CursorPoint;
  readonly moved: boolean;
  /** Foreign pointer events counted across the window. */
  readonly foreignPointerEvents: number;
  readonly voidReason: VoidReason;
}

export interface StillnessResult {
  readonly verdict: StillnessVerdict;
  readonly attempts: readonly StillnessAttempt[];
}

export interface StillnessOptions {
  /** How many times a void attempt may be taken again. */
  readonly maxAttempts: number;
  /** The pointer counter must stay flat this long before a window opens. */
  readonly quietMs: number;
  /** Stop waiting for that gap after this long and measure anyway. */
  readonly quietTimeoutMs: number;
  /** Granularity of both waits above. */
  readonly pollMs: number;
  /**
   * One run-loop turn after the cursor is read, so that a pointer event which
   * entered the tap before that read has actually reached the callback and been
   * counted. Without it the counter can still be flat while the cursor has
   * already moved — the WindowServer moves the pointer whether or not our run
   * loop has drained anything yet.
   */
  readonly flushMs: number;
}

/**
 * Idle cost: one `quietMs` gap plus a round trip plus one flush — about 150 ms.
 * Worst case, a hand that never leaves the trackpad: `maxAttempts` waits of
 * `quietTimeoutMs`, a little over four seconds, and then "could not measure".
 * Neither number is on a path a user waits on — `install.sh` is already
 * building an Electron app, and the toggle path does not await this at all.
 *
 * Measured on the owner's Mac, `--selftest` against the real tap, with whatever
 * the machine happened to be doing:
 *
 *   5–208 real signals in the run  →  verdict in 1–3 attempts, every time
 *   355 real signals               →  could not measure
 *
 * So six attempts is roughly double the margin normal use needed. More
 * attempts, not longer ones: if the pointer has not gone quiet for 120 ms
 * inside 700 ms, waiting another 200 ms in the same breath rarely helps, and an
 * independent try later does.
 */
export const STILLNESS_DEFAULTS: StillnessOptions = {
  maxAttempts: 6,
  quietMs: 120,
  quietTimeoutMs: 700,
  pollMs: 20,
  flushMs: 25,
};

/**
 * Wait for the pointer counter to go flat for `quietMs`, or give up.
 *
 * Giving up is not a failure: the measurement is taken anyway and the window's
 * own contamination check is what decides whether it counted. This only
 * improves the odds of landing in a gap; it never decides anything.
 */
async function waitForQuiet(probe: StillnessProbe, o: StillnessOptions): Promise<void> {
  const needed = Math.ceil(o.quietMs / o.pollMs);
  const budget = Math.ceil(o.quietTimeoutMs / o.pollMs);
  let last = probe.pointerEvents();
  let flat = 0;
  for (let poll = 0; poll < budget && flat < needed; poll++) {
    await probe.sleep(o.pollMs);
    const now = probe.pointerEvents();
    flat = now === last ? flat + 1 : 0;
    last = now;
  }
}

/** One window: read, post, read. Void if anything else was moving the pointer. */
async function measureOnce(
  probe: StillnessProbe,
  o: StillnessOptions,
): Promise<StillnessAttempt | null> {
  await waitForQuiet(probe, o);

  const aliveBefore = probe.tapAlive();
  const eventsBefore = probe.pointerEvents();
  const from = probe.cursor();
  const post = await probe.postAndSettle();
  // Nothing was posted, so nothing could have moved anything. Not an attempt.
  if (!post.posted) return null;
  const to = probe.cursor();

  await probe.sleep(o.flushMs);
  const eventsAfter = probe.pointerEvents();
  const aliveAfter = probe.tapAlive();

  const foreign = eventsAfter - eventsBefore;
  // A cursor read can fail (CGEventCreate returning NULL gives NaN), and
  // `NaN !== NaN` would otherwise read as "the cursor moved" and fail the gate
  // over a failed read. Checked first, because nothing else about this window
  // is meaningful without two positions to compare.
  const readable = [from.x, from.y, to.x, to.y].every((n) => Number.isFinite(n));
  // Order matters only for which reason gets reported; any one of them voids it.
  const voidReason: VoidReason = !readable
    ? "cursor unreadable"
    : !aliveBefore || !aliveAfter
      ? "tap not alive"
      : foreign !== 0
        ? "foreign pointer input"
        : !post.roundTripped
          ? "no round trip"
          : "";

  return {
    from,
    to,
    moved: to.x !== from.x || to.y !== from.y,
    foreignPointerEvents: foreign,
    voidReason,
  };
}

/**
 * Take clean windows until one of them answers, or the attempts run out.
 *
 * The FIRST clean window decides it, pass or fail. There is no voting and no
 * "most attempts said still": a clean window that moved is a regression, and one
 * of those is one too many.
 */
export async function measureCursorStillness(
  probe: StillnessProbe,
  o: StillnessOptions = STILLNESS_DEFAULTS,
): Promise<StillnessResult> {
  const attempts: StillnessAttempt[] = [];
  for (let i = 0; i < o.maxAttempts; i++) {
    const attempt = await measureOnce(probe, o);
    if (attempt === null) return { verdict: "not-posted", attempts };
    attempts.push(attempt);
    if (attempt.voidReason === "") {
      return { verdict: attempt.moved ? "moved" : "still", attempts };
    }
  }
  return { verdict: "inconclusive", attempts };
}

const point = (p: CursorPoint): string => `${String(p.x)},${String(p.y)}`;

/** How many distinct reasons voided the attempts, worst-first, for the detail line. */
function voidSummary(attempts: readonly StillnessAttempt[]): string {
  const reasons = [...new Set(attempts.map((a) => a.voidReason))].filter((r) => r !== "");
  return reasons.length === 0 ? "no attempt was taken" : reasons.join(", ");
}

/**
 * The self-test check, from the measurement.
 *
 * `ok` answers exactly one question — "does this fail the install?" — so an
 * inconclusive check carries `ok: true` AND `inconclusive: true`. It is not
 * silently green: `--selftest` prints it as `?` rather than `ok`, and
 * `install.sh` warns on it. See the comment on `SelfTestCheck.inconclusive`.
 */
export function cursorStillnessCheck(r: StillnessResult): SelfTestCheck {
  const name = "cursor did not move";
  const last = r.attempts.at(-1);
  const tries = `${String(r.attempts.length)} attempt${r.attempts.length === 1 ? "" : "s"}`;

  switch (r.verdict) {
    case "still":
      return {
        name,
        ok: true,
        detail:
          last === undefined
            ? tries
            : `${point(last.from)} → ${point(last.to)} · ${tries}, nothing else moving`,
      };
    case "moved":
      // The one that must never be softened. A clean window means no foreign
      // pointer event arrived, so the only thing that moved the cursor was us.
      return {
        name,
        ok: false,
        detail:
          last === undefined
            ? "moved"
            : `${point(last.from)} → ${point(last.to)} · the jiggle moved it — zero foreign pointer events in the window`,
      };
    case "not-posted":
      return {
        name,
        ok: true,
        inconclusive: true,
        detail: "could not measure: nothing was posted (see 'CGEventPost accepted')",
      };
    case "inconclusive":
      return {
        name,
        ok: true,
        inconclusive: true,
        detail: `could not measure: ${voidSummary(r.attempts)} in all ${tries} — the mouse was in use, so nothing about the jiggler was proven either way`,
      };
  }
}
