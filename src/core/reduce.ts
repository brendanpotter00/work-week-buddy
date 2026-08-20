/**
 * The interval reducer. The whole product is in here.
 *
 * PURE: no electron, no node builtins, no I/O, no clock. Time arrives as a
 * parameter, which is what makes the sleep/wake, crash and late-delivery cases
 * arithmetic instead of a fifteen-minute wait.
 *
 * The rule that outranks everything:
 *
 *   > An interval ends at the timestamp of the last real signal.
 *   > Never `now()`. Never the moment the countdown fired.
 *
 * Get that wrong and every break silently donates fifteen minutes to the week.
 */

import type {
  Config,
  Effect,
  EndReason,
  Ms,
  OpenInterval,
  ClosedInterval,
  ReduceResult,
  Signal,
  StartSource,
  TrackerState,
} from "./types";
import { NO_SIGNAL } from "./types";

/** Close out any open camera/mic/jiggler span at `atMs` and fold it into totals. */
function settleSpans(o: OpenInterval, atMs: Ms): OpenInterval {
  return {
    ...o,
    cameraMs:
      o.cameraMs + (o.cameraSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.cameraSinceMs)),
    micMs: o.micMs + (o.micSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.micSinceMs)),
    jigglerMs:
      o.jigglerMs + (o.jigglerSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.jigglerSinceMs)),
    cameraSinceMs: NO_SIGNAL,
    micSinceMs: NO_SIGNAL,
    jigglerSinceMs: NO_SIGNAL,
  };
}

/**
 * THE close. The end is ALWAYS `lastRealSignalMs`.
 *
 * There is no other caller that creates a ClosedInterval, and there is no
 * parameter here for "end time" — which is what makes writing `now()` here
 * impossible rather than merely discouraged.
 */
function close(o: OpenInterval, reason: EndReason): ClosedInterval {
  const settled = settleSpans(o, o.lastRealSignalMs);
  // Written out field by field rather than spread-minus-rest: the `…SinceMs`
  // fields must not survive into a stored row, and listing the fields means the
  // compiler catches it if OpenInterval ever grows one more.
  return {
    id: settled.id,
    startedAtMs: settled.startedAtMs,
    startSource: settled.startSource,
    lastRealSignalMs: settled.lastRealSignalMs,
    lastInputMs: settled.lastInputMs,
    keyEvents: settled.keyEvents,
    mouseEvents: settled.mouseEvents,
    cameraMs: settled.cameraMs,
    micMs: settled.micMs,
    jigglerMs: settled.jigglerMs,
    endedAtMs: o.lastRealSignalMs,
    durationS: Math.max(0, Math.round((o.lastRealSignalMs - o.startedAtMs) / 1000)),
    endReason: reason,
  };
}

function openAt(atMs: Ms, source: StartSource, s: TrackerState, cfg: Config): OpenInterval {
  return {
    id: cfg.newId(),
    startedAtMs: atMs,
    startSource: source,
    lastRealSignalMs: atMs,
    lastInputMs: source === "input" ? atMs : NO_SIGNAL,
    keyEvents: 0,
    mouseEvents: 0,
    cameraMs: 0,
    micMs: 0,
    jigglerMs: 0,
    cameraSinceMs: s.cameraOn ? atMs : NO_SIGNAL,
    micSinceMs: s.micMeeting ? atMs : NO_SIGNAL,
    jigglerSinceMs: s.jiggler ? atMs : NO_SIGNAL,
  };
}

/** A level signal (camera/mic) holds an interval open. Real input does too. */
function anyLevelHolding(s: TrackerState): boolean {
  return s.cameraOn || s.micMeeting;
}

/** Effects that always accompany a state change, so no call site can forget. */
function settleEffects(next: TrackerState, cfg: Config): Effect[] {
  const fx: Effect[] = [{ kind: "journal", open: next.open }];
  if (next.open) {
    // ABSOLUTE epoch ms. Never a duration — a duration cannot survive sleep.
    fx.push({ kind: "armDeadline", atMs: next.open.lastRealSignalMs + cfg.idleTimeoutMs });
    fx.push({ kind: "tray", workingSinceMs: next.open.startedAtMs });
  } else {
    fx.push({ kind: "cancelDeadline" });
    fx.push({ kind: "tray", workingSinceMs: null });
  }
  return fx;
}

/** Close the open interval (if any) and return the resulting state + effects. */
function closeInto(s: TrackerState, reason: EndReason, cfg: Config): ReduceResult {
  if (!s.open) return { state: s, effects: [] };
  const closed = close(s.open, reason);
  const next: TrackerState = { ...s, open: null, deadlineAtMs: null };
  return {
    state: next,
    effects: [{ kind: "persist", interval: closed }, ...settleEffects(next, cfg)],
  };
}

export function reduce(s: TrackerState, sig: Signal, cfg: Config, nowMs: Ms): ReduceResult {
  // `nowMs` is deliberately not used to compute any stored timestamp. It exists
  // so callers cannot smuggle "now" in through `atMs`, and so a future
  // diagnostic can compare delivery latency against the event's own time.
  void nowMs;

  switch (sig.kind) {
    // ── boot ────────────────────────────────────────────────────────────────
    // Sleep, lid-close, App Nap, force-quit, power loss and reboot all arrive
    // here. There is no per-case branch, and therefore no per-case bug.
    case "boot": {
      const j = sig.journalled;
      if (!j) {
        const next: TrackerState = { ...s, open: null, deadlineAtMs: null };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const stale = sig.atMs - j.lastRealSignalMs > cfg.idleTimeoutMs;
      if (stale) {
        // Machine slept for hours, or crashed. Close at the pre-sleep signal —
        // NOT at wake time, which would count the whole night as work.
        const closed = close(j, "crash_recovered");
        const next: TrackerState = { ...s, open: null, deadlineAtMs: null };
        return {
          state: next,
          effects: [
            { kind: "persist", interval: closed },
            {
              kind: "log",
              event: "crash_recovered",
              detail: `gap ${sig.atMs - j.lastRealSignalMs}ms`,
            },
            ...settleEffects(next, cfg),
          ],
        };
      }
      // Still fresh: resume the SAME interval id. An auto-update restart must
      // not split a six-hour day into two.
      const next: TrackerState = { ...s, open: j };
      return {
        state: next,
        effects: [{ kind: "log", event: "resumed" }, ...settleEffects(next, cfg)],
      };
    }

    // ── real input ──────────────────────────────────────────────────────────
    case "realInput": {
      if (s.paused) return { state: s, effects: [] };
      if (!s.open) {
        const o = openAt(sig.atMs, "input", s, cfg);
        const withCounts: OpenInterval = { ...o, keyEvents: sig.keys, mouseEvents: sig.mouse };
        const next: TrackerState = { ...s, open: withCounts };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const o: OpenInterval = {
        ...s.open,
        lastRealSignalMs: Math.max(s.open.lastRealSignalMs, sig.atMs),
        lastInputMs: Math.max(s.open.lastInputMs, sig.atMs),
        keyEvents: s.open.keyEvents + sig.keys,
        mouseEvents: s.open.mouseEvents + sig.mouse,
      };
      const next: TrackerState = { ...s, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    // ── camera / mic: levels that hold an interval open ──────────────────────
    case "cameraOn":
    case "micMeetingOn": {
      const isCam = sig.kind === "cameraOn";
      const lifted: TrackerState = {
        ...s,
        cameraOn: isCam ? true : s.cameraOn,
        micMeeting: isCam ? s.micMeeting : true,
      };
      if (lifted.paused) return { state: lifted, effects: [] };
      if (!lifted.open) {
        // A meeting joined after 20 idle minutes, without touching anything,
        // opens an interval. Camera on = meeting = work, per the brief.
        const o = openAt(sig.atMs, isCam ? "camera" : "mic", lifted, cfg);
        const next: TrackerState = { ...lifted, open: o };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const o: OpenInterval = {
        ...lifted.open,
        lastRealSignalMs: Math.max(lifted.open.lastRealSignalMs, sig.atMs),
        cameraSinceMs:
          isCam && lifted.open.cameraSinceMs === NO_SIGNAL ? sig.atMs : lifted.open.cameraSinceMs,
        micSinceMs:
          !isCam && lifted.open.micSinceMs === NO_SIGNAL ? sig.atMs : lifted.open.micSinceMs,
      };
      const next: TrackerState = { ...lifted, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    case "cameraOff":
    case "micMeetingOff": {
      const isCam = sig.kind === "cameraOff";
      const dropped: TrackerState = {
        ...s,
        cameraOn: isCam ? false : s.cameraOn,
        micMeeting: isCam ? s.micMeeting : false,
      };
      if (!dropped.open) return { state: dropped, effects: [] };
      const o0 = dropped.open;
      const o: OpenInterval = {
        ...o0,
        // Fold the span that just ended into the total.
        cameraMs:
          isCam && o0.cameraSinceMs !== NO_SIGNAL
            ? o0.cameraMs + Math.max(0, sig.atMs - o0.cameraSinceMs)
            : o0.cameraMs,
        micMs:
          !isCam && o0.micSinceMs !== NO_SIGNAL
            ? o0.micMs + Math.max(0, sig.atMs - o0.micSinceMs)
            : o0.micMs,
        cameraSinceMs: isCam ? NO_SIGNAL : o0.cameraSinceMs,
        micSinceMs: isCam ? o0.micSinceMs : NO_SIGNAL,
        // The camera going off IS a signal — it marks presence up to that moment.
        lastRealSignalMs: Math.max(o0.lastRealSignalMs, sig.atMs),
      };
      const next: TrackerState = { ...dropped, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    // ── the jiggler toggle is an INTERVAL BOUNDARY ───────────────────────────
    // Every stored interval must be homogeneous: jiggler time is 0 or equals
    // the whole duration, never in between. Partial coverage cannot survive the
    // cross-machine union merge, which works on timestamps and needs a single
    // truthful start and end. See PRD §6 and AGENTS.md.
    case "jigglerOn":
    case "jigglerOff": {
      const on = sig.kind === "jigglerOn";
      const closed = closeInto(s, "jiggler_toggle", cfg);
      const next: TrackerState = { ...closed.state, jiggler: on };
      return {
        state: next,
        effects: [...closed.effects, { kind: "log", event: on ? "jiggler_on" : "jiggler_off" }],
      };
      // The next real signal opens a fresh interval, which will be wholly
      // covered or wholly uncovered. Intervals always start at a real signal.
    }

    // ── pause ───────────────────────────────────────────────────────────────
    case "pauseOn": {
      const closed = closeInto(s, "pause", cfg);
      return {
        state: { ...closed.state, paused: true },
        effects: [...closed.effects, { kind: "log", event: "pause_on" }],
      };
    }

    case "pauseOff":
      return {
        state: { ...s, paused: false },
        effects: [{ kind: "log", event: "pause_off" }],
      };

    // ── the countdown ───────────────────────────────────────────────────────
    case "deadlineFired": {
      if (!s.open) return { state: s, effects: [] };
      const o = s.open;

      // Camera-only cap. A forgotten Zoom or a virtual camera left running
      // would otherwise log a 14-hour day.
      const inputAge =
        o.lastInputMs === NO_SIGNAL ? sig.atMs - o.startedAtMs : sig.atMs - o.lastInputMs;
      if (anyLevelHolding(s) && inputAge > cfg.cameraOnlyMaxMs) {
        const closed = closeInto(s, "camera_cap", cfg);
        return {
          state: closed.state,
          effects: [...closed.effects, { kind: "log", event: "camera_cap" }],
        };
      }

      // A level signal still holds it open. Push the deadline out and keep the
      // interval alive — this is what carries a 50-minute meeting with no mouse.
      if (anyLevelHolding(s)) {
        const bumped: OpenInterval = {
          ...o,
          lastRealSignalMs: Math.max(o.lastRealSignalMs, sig.atMs),
        };
        const next: TrackerState = { ...s, open: bumped };
        return { state: next, effects: settleEffects(next, cfg) };
      }

      // Not yet due. The timer was armed for an older deadline and the interval
      // has been extended since — re-arm rather than close. This is the "lazy"
      // in lazy re-arm: one timer op per timeout, not one per keystroke.
      if (sig.atMs - o.lastRealSignalMs < cfg.idleTimeoutMs) {
        return { state: s, effects: settleEffects(s, cfg) };
      }

      const closed = closeInto(s, "idle_timeout", cfg);
      return { state: closed.state, effects: closed.effects };
    }

    // ── the tap died ────────────────────────────────────────────────────────
    // We may have silently missed input. Closing at the last signal we actually
    // trust is the honest thing; the alternative is inventing time.
    case "tapLost": {
      const closed = closeInto(s, "tap_lost", cfg);
      return {
        state: closed.state,
        effects: [...closed.effects, { kind: "log", event: "tap_lost" }],
      };
    }

    // ── quit ────────────────────────────────────────────────────────────────
    // Leave the row OPEN in the journal. The next boot applies the identical
    // rule, so quit needs no special handling and cannot lose the tail.
    case "appQuit":
      return {
        state: s,
        effects: [{ kind: "journal", open: s.open }, { kind: "log", event: "quit" }],
      };
  }
}
