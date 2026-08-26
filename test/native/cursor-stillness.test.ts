/**
 * The cursor-stillness check, driven against a scripted Mac.
 *
 * This is the one part of `--selftest` that can be honestly unit-tested, and it
 * is the part that needed it most: the old check compared two cursor reads and
 * failed if they differed, which is a correct measurement of an idle Mac and a
 * coin flip on one somebody is using. It failed the owner's install twice, on
 * the single path where a human is guaranteed to be at the keyboard, while every
 * check that actually discriminates passed.
 *
 * Two properties matter here and they pull in opposite directions:
 *
 *   1. A human moving the mouse must NOT produce a failure.
 *   2. A jiggler that genuinely moves the cursor MUST still fail.
 *
 * Getting (1) by giving up (2) would be worse than the bug. So the second half
 * of this file attacks (2) directly, including with a property test that says no
 * arrangement of human input anywhere in the run can turn a cursor-moving
 * jiggler into a pass.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  cursorStillnessCheck,
  measureCursorStillness,
  STILLNESS_DEFAULTS,
  type CursorPoint,
  type PostOutcome,
  type StillnessOptions,
  type StillnessProbe,
  type StillnessResult,
} from "../../src/native/cursor-stillness";

/**
 * A Mac, scripted.
 *
 * Every wait is a counted call rather than a real timer, so a run that would
 * take five seconds of wall clock is arithmetic and finishes in microseconds.
 * The two hooks are the only places anything is allowed to happen: `onSleep`
 * fires on every wait, `onPost` fires inside the measurement window itself —
 * between the two cursor reads, which is the exact interval the old check could
 * not survive.
 */
class FakeMac implements StillnessProbe {
  x = 100;
  y = 200;
  /** Foreign, non-keyboard events the tap has counted. Never our own jiggle. */
  pointerCount = 0;
  alive = true;
  roundTrips = true;
  canPost = true;
  readable = true;
  /** THE REGRESSION: how far one post drags the cursor. Zero is the promise. */
  postDelta = 0;

  posts = 0;
  sleeps = 0;
  onSleep: (m: FakeMac) => void = () => undefined;
  onPost: (m: FakeMac) => void = () => undefined;

  /** A hand on the trackpad: the pointer moves and the tap sees it move. */
  humanMoves(px = 3): void {
    this.x += px;
    this.pointerCount++;
  }

  /**
   * Typing. The tap sees it, the pointer counter does not — a keystroke cannot
   * move a cursor, so it must never void a cursor measurement. Modelled as a
   * no-op here precisely because that is what the real counter does.
   */
  humanTypes(): void {
    /* deliberately nothing: keystrokes are not pointer events */
  }

  cursor(): CursorPoint {
    return this.readable ? { x: this.x, y: this.y } : { x: NaN, y: NaN };
  }

  pointerEvents(): number {
    return this.pointerCount;
  }

  tapAlive(): boolean {
    return this.alive;
  }

  postAndSettle(): Promise<PostOutcome> {
    this.posts++;
    if (!this.canPost) return Promise.resolve({ posted: false, roundTripped: false });
    this.x += this.postDelta;
    this.onPost(this);
    return Promise.resolve({ posted: true, roundTripped: this.roundTrips });
  }

  sleep(): Promise<void> {
    this.sleeps++;
    this.onSleep(this);
    return Promise.resolve();
  }
}

const OPTS: StillnessOptions = STILLNESS_DEFAULTS;
const run = (m: FakeMac, o: StillnessOptions = OPTS): Promise<StillnessResult> =>
  measureCursorStillness(m, o);

/** A human whose hand leaves the trackpad after `n` attempts' worth of windows. */
function stopsAfterPosts(m: FakeMac, n: number): void {
  const busy = (): boolean => m.posts < n;
  m.onSleep = () => {
    if (busy()) m.humanMoves();
  };
  m.onPost = () => {
    if (busy()) m.humanMoves();
  };
}

describe("an undisturbed Mac", () => {
  it("proves the jiggle moved nothing, in one attempt", async () => {
    const m = new FakeMac();
    const r = await run(m);

    expect(r.verdict).toBe("still");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.voidReason).toBe("");
    expect(r.attempts[0]?.foreignPointerEvents).toBe(0);

    const check = cursorStillnessCheck(r);
    expect(check.ok).toBe(true);
    expect(check.inconclusive).toBeUndefined();
    // The name is load-bearing: docs/MACOS.md and the install transcript both
    // refer to it, and the owner greps for it.
    expect(check.name).toBe("cursor did not move");
    expect(check.detail).toContain("100,200 → 100,200");
  });

  it("costs one quiet gap, not the whole budget", async () => {
    const m = new FakeMac();
    await run(m);
    // quietMs / pollMs polls of flatness, plus the one flush. Anything much
    // larger means the check is sitting on a path a person is waiting on.
    expect(m.sleeps).toBe(OPTS.quietMs / OPTS.pollMs + 1);
    expect(m.posts).toBe(1);
  });
});

describe("a human using the Mac — the false failure this fixes", () => {
  it("does not fail when the mouse moves inside the measurement window", async () => {
    // The owner's exact situation: real signals arriving, the cursor genuinely
    // in a different place afterwards, and nothing whatsoever wrong with the
    // app. The old check reported FAIL for this and refused the install.
    const m = new FakeMac();
    stopsAfterPosts(m, 2);

    const r = await run(m);

    expect(r.verdict).toBe("still");
    // The first windows were thrown away, not failed.
    expect(r.attempts[0]?.voidReason).toBe("foreign pointer input");
    expect(r.attempts[0]?.moved).toBe(true);
    expect(cursorStillnessCheck(r).ok).toBe(true);
  });

  it("reports could-not-measure, never a failure, when the hand never leaves", async () => {
    const m = new FakeMac();
    m.onSleep = (x) => {
      x.humanMoves();
    };
    m.onPost = (x) => {
      x.humanMoves();
    };

    const r = await run(m);

    expect(r.verdict).toBe("inconclusive");
    expect(r.attempts).toHaveLength(OPTS.maxAttempts);
    expect(r.attempts.every((a) => a.voidReason === "foreign pointer input")).toBe(true);

    const check = cursorStillnessCheck(r);
    // Not a failure — the install must not stop because somebody used their Mac.
    expect(check.ok).toBe(true);
    // …and not silently green either.
    expect(check.inconclusive).toBe(true);
    expect(check.detail).toContain("could not measure");
    expect(check.detail).toContain("nothing about the jiggler was proven");
  });

  it("is not voided by typing, which cannot move a cursor", async () => {
    // install.sh runs --selftest one line after a command the owner typed, so
    // hands-on-keyboard is the normal case. Counting keystrokes as
    // contamination would void every window for no reason at all.
    const m = new FakeMac();
    m.onSleep = (x) => {
      x.humanTypes();
    };
    m.onPost = (x) => {
      x.humanTypes();
    };

    const r = await run(m);
    expect(r.verdict).toBe("still");
    expect(r.attempts).toHaveLength(1);
  });

  it("waits for the gap rather than measuring on top of the movement", async () => {
    const m = new FakeMac();
    let moves = 0;
    m.onSleep = (x) => {
      if (moves++ < 10) x.humanMoves();
    };

    const r = await run(m);

    expect(r.verdict).toBe("still");
    // One attempt: the wait found the pause instead of burning a retry on it.
    expect(r.attempts).toHaveLength(1);
    expect(m.posts).toBe(1);
  });
});

describe("a jiggler that genuinely moves the cursor — this must never regress", () => {
  it("fails the gate on an undisturbed Mac", async () => {
    const m = new FakeMac();
    m.postDelta = 1; // one pixel is a regression

    const r = await run(m);

    expect(r.verdict).toBe("moved");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.voidReason).toBe("");
    expect(r.attempts[0]?.foreignPointerEvents).toBe(0);

    const check = cursorStillnessCheck(r);
    expect(check.ok).toBe(false);
    expect(check.inconclusive).toBeUndefined();
    expect(check.detail).toContain("the jiggle moved it");
    expect(check.detail).toContain("zero foreign pointer events");
  });

  it("still fails once the human's hand comes off the trackpad", async () => {
    // Contamination can COST the regression an attempt. It cannot hide it: our
    // own posted event never reaches the pointer counter, so the first window
    // the human is not in is clean, and it shows the movement.
    const m = new FakeMac();
    m.postDelta = 2;
    stopsAfterPosts(m, 2);

    const r = await run(m);

    expect(r.verdict).toBe("moved");
    expect(cursorStillnessCheck(r).ok).toBe(false);
  });

  it("fails on a sub-pixel drag, which is what a real one would look like", async () => {
    const m = new FakeMac();
    m.postDelta = 0.25;

    expect((await run(m)).verdict).toBe("moved");
  });

  it("can never be reported as still, whatever the human does", async () => {
    // The guarantee, stated as a property: contamination may downgrade a
    // regression to "could not measure", but there is no arrangement of human
    // input anywhere in the run that upgrades it to a pass.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.double({ min: 0.01, max: 50, noNaN: true }),
        async (sleepScript, postScript, delta) => {
          const m = new FakeMac();
          m.postDelta = delta;
          let i = 0;
          let j = 0;
          m.onSleep = (x) => {
            if (sleepScript[i++ % sleepScript.length] === true) x.humanMoves();
          };
          m.onPost = (x) => {
            if (postScript[j++ % postScript.length] === true) x.humanMoves();
          };

          const r = await run(m);
          expect(r.verdict).not.toBe("still");
          expect(cursorStillnessCheck(r).inconclusive === true || !cursorStillnessCheck(r).ok).toBe(
            true,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("windows that cannot be trusted are thrown away, not scored", () => {
  it("voids the window while the tap is down, because the counter is blind then", async () => {
    // A flat pointer counter proves nothing if nothing could have incremented
    // it. Treating it as clean would let a real regression pass during exactly
    // the outage that hid the evidence.
    const m = new FakeMac();
    m.alive = false;
    m.postDelta = 5;

    const r = await run(m);

    expect(r.verdict).toBe("inconclusive");
    expect(r.attempts.every((a) => a.voidReason === "tap not alive")).toBe(true);
    expect(cursorStillnessCheck(r).ok).toBe(true);
    expect(cursorStillnessCheck(r).inconclusive).toBe(true);
  });

  it("voids the window when our own post never came back", async () => {
    // Until the event has been through the WindowServer and back, an unmoved
    // cursor only says the WindowServer has not got to it yet.
    const m = new FakeMac();
    m.roundTrips = false;

    const r = await run(m);

    expect(r.verdict).toBe("inconclusive");
    expect(r.attempts.every((a) => a.voidReason === "no round trip")).toBe(true);
  });

  it("voids the window on an unreadable cursor rather than failing on NaN", async () => {
    // CGEventCreate returning NULL gives NaN, and `NaN !== NaN` would read as
    // "the cursor moved" — a failed install over a failed read.
    const m = new FakeMac();
    m.readable = false;

    const r = await run(m);

    expect(r.verdict).toBe("inconclusive");
    expect(r.attempts.every((a) => a.voidReason === "cursor unreadable")).toBe(true);
    expect(cursorStillnessCheck(r).ok).toBe(true);
  });

  it("reports not-posted without inventing an attempt", async () => {
    // No Accessibility grant. Nothing was posted, so nothing could have moved
    // anything, and 'the cursor did not move' would be a meaningless pass.
    // 'CGEventPost accepted' is the check that fails this case.
    const m = new FakeMac();
    m.canPost = false;

    const r = await run(m);

    expect(r.verdict).toBe("not-posted");
    expect(r.attempts).toHaveLength(0);
    const check = cursorStillnessCheck(r);
    expect(check.ok).toBe(true);
    expect(check.inconclusive).toBe(true);
    expect(check.detail).toContain("CGEventPost accepted");
  });
});

describe("the retry budget", () => {
  it("is bounded — exhaustion is a reported state, not a hang", async () => {
    const m = new FakeMac();
    m.onSleep = (x) => {
      x.humanMoves();
    };

    const r = await run(m, { ...OPTS, maxAttempts: 2 });

    expect(r.verdict).toBe("inconclusive");
    expect(r.attempts).toHaveLength(2);
    expect(m.posts).toBe(2);
  });

  it("gives up waiting for a gap instead of waiting forever", async () => {
    const m = new FakeMac();
    m.onSleep = (x) => {
      x.humanMoves();
    };

    await run(m, { ...OPTS, maxAttempts: 1 });

    // quietTimeoutMs/pollMs polls at most, plus the flush, and then it measures
    // anyway — the window's own contamination check is what decides.
    expect(m.sleeps).toBeLessThanOrEqual(OPTS.quietTimeoutMs / OPTS.pollMs + 1);
  });

  it("stops at the first clean window rather than sampling for a majority", async () => {
    // A clean window that moved is a regression, and one of those is one too
    // many. There is no voting here.
    const m = new FakeMac();
    m.postDelta = 1;

    const r = await run(m, { ...OPTS, maxAttempts: 9 });

    expect(r.verdict).toBe("moved");
    expect(m.posts).toBe(1);
  });
});
