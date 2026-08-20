/**
 * The live stopwatch's state machine — pure, so every branch is testable
 * without a DOM, and shared, so the menu bar and the window cannot disagree
 * about the session in front of you (the same reason `format.ts` is shared).
 *
 * It has no start button and no stop button. The interval machine in main
 * decides when a session is open; this only ever renders that decision.
 *
 * WHY A NAIVE `now − openedAtMs` IS NOT GOOD ENOUGH
 *
 * There are five states in which that subtraction produces a number that is
 * either wrong or about to be thrown away. Each gets its own tone and its own
 * sentence rather than a confident clock:
 *
 *  - PAUSED — nothing is being recorded, so nothing may advance. The clock is
 *    computed from `asOfMs`, the snapshot's own timestamp, so it cannot creep
 *    even if a display tick arrives.
 *  - IDLE — there is no session, so there are no digits. `—`, never `0:00:00`:
 *    a zeroed clock reads as "just started".
 *  - HELD OPEN by a camera or a meeting mic — credited only to
 *    `min(now, heldUntilMs)` (PRD §3.4). Past the cap the clock STOPS rather
 *    than counting a forgotten Zoom call all night.
 *  - JIGGLER ON with `countJigglerTime: 0` — this time will not survive
 *    `v_countable`, so it never reaches his hours at all. Digits racing ahead
 *    on time that is being discarded on purpose are a lie, not a stopwatch, so
 *    they go muted and say so.
 *  - DEGRADED in a way that breaks MEASUREMENT — the input signal this session
 *    is built out of is broken, or the row cannot be written. The number is
 *    still shown, because it is still literally true, but it is not presented
 *    as confident.
 *
 * WHAT IT IS NOT
 *
 * Nothing here is scheduled from `deadlineMs` — `ipc-types.ts` forbids it and a
 * hidden renderer's timers collapse (`AGENTS.md` trap #10). Every value is
 * recomputed from the absolute epoch ms in the snapshot, so a dropped tick
 * costs a stale frame and never a wrong number.
 *
 * And `liveSessionMs()` is a WALL CLOCK. It is never an hours figure: those are
 * built on `creditedOpenMs()`, which ends at the last real signal because that
 * is what the close rule will write. Conflating them would put `now()` into an
 * hours number, which AGENTS.md says outranks everything.
 */
import { formatStopwatch, isHoldCapped, liveSessionMs } from "./format";
import type { DegradedReason, HoldKind, LiveStatus, MetricsPolicy } from "./ipc-types";

/**
 * One visual treatment per honest state. `running` and `held` are the only two
 * that are allowed to look like a confident clock; every other value is a
 * deliberate signal that the number in front of you needs a caveat.
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
  /** whether this may LOOK healthy: full-strength digits and a pulsing dot */
  confident: boolean;
  tone: StopwatchTone;
  /** the eyebrow, and the tray's interval line. Short enough for a menu item. */
  label: string;
  /** why the number is what it is, in words. Always present. */
  note: string;
  /** the ⚠︎ the stat cards use for a number the banner has already spoiled */
  warn: boolean;
}

/** No `input` case and no cast: `HoldKind` cannot be `"input"`. */
const HOLD_NOUN: Record<HoldKind, string> = {
  camera: "camera",
  mic: "meeting mic",
};

/**
 * The degraded reasons that make THIS SESSION'S number untrustworthy.
 *
 * Deliberately not `degraded.length > 0`. Three of the seven reasons say
 * nothing at all about the clock in front of you, and muting a correct number
 * because the cloud is unhappy teaches the reader to ignore the ⚠︎:
 *
 *  - `accessibility_missing` — its own docstring says "Tracking is unaffected".
 *    It means the JIGGLER cannot post, which is a different feature.
 *  - `sync_silent_72h`, `fingerprint_mismatch` — this session is being measured
 *    and stored correctly; it is the copy in the cloud that is behind.
 *
 * The four below do reach the digits: three break the input signal the session
 * is made of, and `db_unwritable` means the session will not be saved at all —
 * the same "this is going to be thrown away" the jiggler case has.
 */
const MEASUREMENT_BROKEN: ReadonlySet<DegradedReason> = new Set<DegradedReason>([
  "keyboard_permission_missing",
  "tap_lost",
  "relaunch_required",
  "db_unwritable",
]);

/** The first reason that spoils the session clock, or `null`. Order = severity. */
export function measurementBreaker(status: LiveStatus): DegradedReason | null {
  return status.degraded.find((r) => MEASUREMENT_BROKEN.has(r)) ?? null;
}

const BREAKER_NOTE: Record<DegradedReason, string> = {
  keyboard_permission_missing:
    "Typing is invisible right now, so this session may already have been cut short.",
  tap_lost: "The input tap is dead — nothing you do is reaching this timer.",
  relaunch_required:
    "A permission was granted, but this session is still being measured without it.",
  db_unwritable: "The database cannot be written, so this session is not being saved.",
  // Never selected: MEASUREMENT_BROKEN does not contain these. Present so the
  // record is exhaustive and adding a DegradedReason is a compile error here
  // rather than a blank sentence in the app.
  accessibility_missing: "The jiggler cannot post. Tracking is unaffected.",
  sync_silent_72h: "Nothing has reached the cloud recently. This session is still being recorded.",
  fingerprint_mismatch: "The cloud disagrees about row counts. This session is still being recorded.",
};

/**
 * The whole state machine, as a pure function.
 *
 * Precedence runs most-alarming first, because what the reader needs is the
 * reason the number is NOT what they expect: a paused tracker outranks a broken
 * signal, which outranks a session that is being discarded on purpose, which
 * outranks a camera hold.
 */
export function stopwatchView(
  status: LiveStatus | null,
  policy: Pick<MetricsPolicy, "countJigglerTime">,
  nowMs: number,
): StopwatchView {
  // Before the first snapshot lands. Not a claim that he is idle — just nothing
  // to say yet, so no digits and no words.
  if (status === null) {
    return {
      ms: null,
      ticking: false,
      confident: false,
      tone: "idle",
      label: "—",
      note: " ",
      warn: false,
    };
  }

  if (status.state === "paused") {
    // `pauseOn` closes the open interval (`reduce.ts`), so this is normally a
    // dash. The frozen clock is the defensive half: computing from `asOfMs`
    // rather than `nowMs` means even a paused snapshot that still carried an
    // open interval could not advance on a display tick.
    return {
      ms: liveSessionMs(status, status.asOfMs),
      ticking: false,
      confident: false,
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
      confident: false,
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

  const breaker = measurementBreaker(status);
  if (breaker !== null) {
    // The elapsed time is still literally true — the session did open when it
    // says it did — so it is shown rather than hidden. What it does not get is
    // the pulsing dot and full-strength digits: the banner above already names
    // the reason, and this wears the same ⚠︎ the stat cards wear.
    return {
      ms,
      ticking: !capped,
      confident: false,
      tone: "degraded",
      label: "Unverified",
      note: BREAKER_NOTE[breaker],
      warn: true,
    };
  }

  if (status.jigglerOnForOpenInterval && policy.countJigglerTime === 0) {
    return {
      ms,
      ticking: !capped,
      confident: false,
      tone: "uncounted",
      label: "Not counted",
      note: "The jiggler is on, so this session will not count toward your hours.",
      warn: false,
    };
  }

  if (held !== null && capped) {
    return {
      ms,
      ticking: false,
      confident: false,
      tone: "capped",
      label: "Capped",
      note: `Stopped at the ${HOLD_NOUN[held]} cap — a meeting left running does not count past this.`,
      warn: false,
    };
  }

  if (held !== null) {
    return {
      ms,
      ticking: true,
      confident: true,
      tone: "held",
      label: "Working",
      note:
        status.heldUntilMs === null
          ? `Held open by the ${HOLD_NOUN[held]} rather than by you.`
          : // Where the cap lands ON THE CLOCK, not on the wall: it is the same
            // number he is watching count up, so no arithmetic is needed to see
            // how much rope is left.
            `Held open by the ${HOLD_NOUN[held]} — the clock stops at ${formatStopwatch(
              status.heldUntilMs - status.openedAtMs,
            )}.`,
      warn: false,
    };
  }

  return {
    ms,
    ticking: true,
    confident: true,
    tone: "running",
    label: "Working",
    note: `Started at ${new Date(status.openedAtMs).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}.`,
    warn: false,
  };
}

/**
 * The tray's interval line — same words, same digits, same state machine as the
 * dashboard, because the menu bar and the window are not allowed to disagree
 * about the session that is open right now.
 *
 * The menu is rebuilt on every open (`tray.ts`), which is what makes seconds
 * safe HERE and unsafe in the TITLE: the title is a live string in the menu
 * bar, and rewriting it once a second reflows every icon to its left.
 */
export function traySessionLabel(
  status: LiveStatus,
  policy: Pick<MetricsPolicy, "countJigglerTime">,
  nowMs: number,
): string {
  const v = stopwatchView(status, policy, nowMs);
  return v.ms === null ? v.label : `${v.label} · ${formatStopwatch(v.ms)}`;
}
