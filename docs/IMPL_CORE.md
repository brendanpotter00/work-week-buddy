# IMPL_CORE — the interval reducer

**Tasks 2.1 and 2.2.** Every number the product ever shows comes out of this file. It is also the only part that is pure, fully testable, and impossible to get right by inspection — so it gets the most tests.

**The rule this whole document exists to protect:**

> An interval ends at the timestamp of the **last real signal**. Never `now()`. Never the moment the countdown fired.

Get that wrong and every break silently donates fifteen minutes to the week. It is enforced three ways: the reducer never has access to a clock, a database CHECK constraint rejects the wrong value, and a property test asserts it over arbitrary signal streams.

---

## 1. Time, and why it is a parameter

`src/core/` never reads the clock. Two different times matter and conflating them is a bug:

| | What it is | Where it comes from |
|---|---|---|
| `signal.atMs` | when the event **actually happened** | `CGEventGetTimestamp`, converted to epoch ms. Can be older than now. |
| `nowMs` | when we are **processing** it | passed in by the caller |

An interval's end is always a `signal.atMs`, never a `nowMs`. That is the whole distinction, and it is why the callback's delivery latency — measured at up to 5.4 s under an abusive drain — cannot corrupt the data.

```ts
/** Epoch milliseconds, UTC. */
export type Ms = number;

/** Sentinel for "no signal yet". Never use 0 — 0 is a valid epoch. */
export const NO_SIGNAL = -1 as const;
```

---

## 2. Types

`src/core/types.ts`, complete.

```ts
export type Ms = number;
export const NO_SIGNAL = -1;

// ─────────────────────────────────────────────────────────── signals in

export type Signal =
  /** App start. Carries whatever was journalled, so recovery is a transition
   *  like any other rather than a special case in the boot path. */
  | { kind: "boot"; atMs: Ms; journalled: OpenInterval | null }
  /** Real human input from the tap. Our own jiggles are filtered in
   *  src/native/ and never reach here — see IMPL_NATIVE §5. */
  | { kind: "realInput"; atMs: Ms; keys: number; mouse: number }
  | { kind: "cameraOn"; atMs: Ms }
  | { kind: "cameraOff"; atMs: Ms }
  /** Already conjoined with "a meeting app is running" — see §6. */
  | { kind: "micMeetingOn"; atMs: Ms }
  | { kind: "micMeetingOff"; atMs: Ms }
  | { kind: "jigglerOn"; atMs: Ms }
  | { kind: "jigglerOff"; atMs: Ms }
  | { kind: "pauseOn"; atMs: Ms }
  | { kind: "pauseOff"; atMs: Ms }
  /** The countdown reached zero. atMs is when it fired, which after sleep can
   *  be much later than the deadline it was armed for. */
  | { kind: "deadlineFired"; atMs: Ms }
  /** The 5-minute watchdog found the tap dead. Treated as "we may have missed
   *  input", so the interval closes at the last signal we actually trust. */
  | { kind: "tapLost"; atMs: Ms }
  | { kind: "appQuit"; atMs: Ms };

// ─────────────────────────────────────────────────────────── state

export type StartSource = "input" | "camera" | "mic" | "recovery";

export type EndReason =
  | "idle_timeout"
  | "camera_cap"
  | "jiggler_toggle"
  | "pause"
  | "app_quit"
  | "tap_lost"
  | "crash_recovered";

export interface OpenInterval {
  readonly id: string;
  readonly startedAtMs: Ms;
  readonly startSource: StartSource;
  /** THE load-bearing field. The interval will end here. */
  readonly lastRealSignalMs: Ms;
  /** Last *keyboard or mouse* signal specifically. Camera and mic do not move
   *  it, which is what makes the camera-only cap computable. */
  readonly lastInputMs: Ms;
  readonly keyEvents: number;
  readonly mouseEvents: number;
  /** Accumulated, closed-out spans. The `…SinceMs` fields hold the open span. */
  readonly cameraMs: number;
  readonly micMs: number;
  readonly jigglerMs: number;
  readonly cameraSinceMs: Ms;   // NO_SIGNAL when off
  readonly micSinceMs: Ms;      // NO_SIGNAL when off
  readonly jigglerSinceMs: Ms;  // NO_SIGNAL when off
}

export interface ClosedInterval extends Omit<OpenInterval, "cameraSinceMs" | "micSinceMs" | "jigglerSinceMs"> {
  readonly endedAtMs: Ms;
  readonly durationS: number;
  readonly endReason: EndReason;
}

export interface TrackerState {
  readonly open: OpenInterval | null;
  readonly cameraOn: boolean;
  readonly micMeeting: boolean;
  readonly jiggler: boolean;
  readonly paused: boolean;
  /** Absolute epoch ms. Never a duration — a duration cannot survive sleep. */
  readonly deadlineAtMs: Ms | null;
}

export const initialState: TrackerState = {
  open: null, cameraOn: false, micMeeting: false,
  jiggler: false, paused: false, deadlineAtMs: null,
};

// ─────────────────────────────────────────────────────────── effects out

export type Effect =
  /** Journal the open interval so a crash cannot lose the truncation point. */
  | { kind: "journal"; open: OpenInterval | null }
  /** Write a finished interval. The only place rows are created. */
  | { kind: "persist"; interval: ClosedInterval }
  | { kind: "armDeadline"; atMs: Ms }
  | { kind: "cancelDeadline" }
  | { kind: "tray"; workingSinceMs: Ms | null }
  | { kind: "log"; event: string; detail?: string };

export interface Config {
  readonly idleTimeoutMs: number;      // 15 min
  readonly minIntervalMs: number;      // 90 s — kept, but not counted
  readonly cameraOnlyMaxMs: number;    // 6 h
  readonly newId: () => string;        // injected, so tests are deterministic
}

export interface ReduceResult {
  readonly state: TrackerState;
  readonly effects: readonly Effect[];
}
```

**Why `newId` is injected:** the reducer must be deterministic to be property-tested. A UUID generator inside it would make every run different and every failure unreproducible.

---

## 3. The reducer

`src/core/reduce.ts`, complete.

```ts
import type {
  Signal, TrackerState, OpenInterval, ClosedInterval, Effect,
  Config, ReduceResult, EndReason, StartSource,
} from "./types";
import { NO_SIGNAL } from "./types";

/** Close out any open camera/mic/jiggler span at `atMs` and fold it into totals. */
function settleSpans(o: OpenInterval, atMs: Ms): OpenInterval {
  return {
    ...o,
    cameraMs: o.cameraMs + (o.cameraSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.cameraSinceMs)),
    micMs: o.micMs + (o.micSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.micSinceMs)),
    jigglerMs: o.jigglerMs + (o.jigglerSinceMs === NO_SIGNAL ? 0 : Math.max(0, atMs - o.jigglerSinceMs)),
    cameraSinceMs: NO_SIGNAL, micSinceMs: NO_SIGNAL, jigglerSinceMs: NO_SIGNAL,
  };
}

/** THE close. The end is ALWAYS lastRealSignalMs. There is no other caller
 *  that creates a ClosedInterval, and no parameter here for "end time" —
 *  which is what makes writing `now()` here impossible rather than merely
 *  discouraged. */
function close(o: OpenInterval, reason: EndReason): ClosedInterval {
  const settled = settleSpans(o, o.lastRealSignalMs);
  const {
    cameraSinceMs: _c, micSinceMs: _m, jigglerSinceMs: _j, ...rest
  } = settled;
  return {
    ...rest,
    endedAtMs: o.lastRealSignalMs,
    durationS: Math.max(0, Math.round((o.lastRealSignalMs - o.startedAtMs) / 1000)),
    endReason: reason,
  };
}

function open(atMs: Ms, source: StartSource, s: TrackerState, cfg: Config): OpenInterval {
  return {
    id: cfg.newId(),
    startedAtMs: atMs,
    startSource: source,
    lastRealSignalMs: atMs,
    lastInputMs: source === "input" ? atMs : NO_SIGNAL,
    keyEvents: 0, mouseEvents: 0,
    cameraMs: 0, micMs: 0, jigglerMs: 0,
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
  switch (sig.kind) {

    // ── boot ────────────────────────────────────────────────────────────────
    // Sleep, lid-close, App Nap, force-quit, power loss and reboot all arrive
    // here. There is no per-case branch, and therefore no per-case bug.
    case "boot": {
      const j = sig.journalled;
      if (!j) {
        const next = { ...s, open: null, deadlineAtMs: null };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const stale = sig.atMs - j.lastRealSignalMs > cfg.idleTimeoutMs;
      if (stale) {
        // Machine slept for hours, or crashed. Close at the pre-sleep signal —
        // NOT at wake time, which would count the whole night as work.
        const closed = close(j, "crash_recovered");
        const next = { ...s, open: null, deadlineAtMs: null };
        return {
          state: next,
          effects: [
            { kind: "persist", interval: closed },
            { kind: "log", event: "crash_recovered", detail: `gap ${sig.atMs - j.lastRealSignalMs}ms` },
            ...settleEffects(next, cfg),
          ],
        };
      }
      // Still fresh: resume the SAME interval id. An auto-update restart must
      // not split a six-hour day into two.
      const next = { ...s, open: j };
      return { state: next, effects: [{ kind: "log", event: "resumed" }, ...settleEffects(next, cfg)] };
    }

    // ── real input ──────────────────────────────────────────────────────────
    case "realInput": {
      if (s.paused) return { state: s, effects: [] };
      if (!s.open) {
        const o = open(sig.atMs, "input", s, cfg);
        const withCounts = { ...o, keyEvents: sig.keys, mouseEvents: sig.mouse };
        const next = { ...s, open: withCounts };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const o: OpenInterval = {
        ...s.open,
        lastRealSignalMs: Math.max(s.open.lastRealSignalMs, sig.atMs),
        lastInputMs: Math.max(s.open.lastInputMs, sig.atMs),
        keyEvents: s.open.keyEvents + sig.keys,
        mouseEvents: s.open.mouseEvents + sig.mouse,
      };
      const next = { ...s, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    // ── camera / mic: levels that hold an interval open ──────────────────────
    case "cameraOn":
    case "micMeetingOn": {
      const isCam = sig.kind === "cameraOn";
      const lifted = { ...s, cameraOn: isCam ? true : s.cameraOn, micMeeting: isCam ? s.micMeeting : true };
      if (lifted.paused) return { state: lifted, effects: [] };
      if (!lifted.open) {
        // A meeting joined after 20 idle minutes, without touching anything,
        // opens an interval. Camera on = meeting = work, per the brief.
        const o = open(sig.atMs, isCam ? "camera" : "mic", lifted, cfg);
        const next = { ...lifted, open: o };
        return { state: next, effects: settleEffects(next, cfg) };
      }
      const o: OpenInterval = {
        ...lifted.open,
        lastRealSignalMs: Math.max(lifted.open.lastRealSignalMs, sig.atMs),
        cameraSinceMs: isCam && lifted.open.cameraSinceMs === NO_SIGNAL ? sig.atMs : lifted.open.cameraSinceMs,
        micSinceMs: !isCam && lifted.open.micSinceMs === NO_SIGNAL ? sig.atMs : lifted.open.micSinceMs,
      };
      const next = { ...lifted, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    case "cameraOff":
    case "micMeetingOff": {
      const isCam = sig.kind === "cameraOff";
      const dropped = { ...s, cameraOn: isCam ? false : s.cameraOn, micMeeting: isCam ? s.micMeeting : false };
      if (!dropped.open) return { state: dropped, effects: [] };
      const o0 = dropped.open;
      const o: OpenInterval = {
        ...o0,
        // Fold the span that just ended into the total.
        cameraMs: isCam && o0.cameraSinceMs !== NO_SIGNAL
          ? o0.cameraMs + Math.max(0, sig.atMs - o0.cameraSinceMs) : o0.cameraMs,
        micMs: !isCam && o0.micSinceMs !== NO_SIGNAL
          ? o0.micMs + Math.max(0, sig.atMs - o0.micSinceMs) : o0.micMs,
        cameraSinceMs: isCam ? NO_SIGNAL : o0.cameraSinceMs,
        micSinceMs: isCam ? o0.micSinceMs : NO_SIGNAL,
        // The camera going off IS a signal — it marks presence up to that moment.
        lastRealSignalMs: Math.max(o0.lastRealSignalMs, sig.atMs),
      };
      const next = { ...dropped, open: o };
      return { state: next, effects: settleEffects(next, cfg) };
    }

    // ── the jiggler toggle is an INTERVAL BOUNDARY ───────────────────────────
    // Every stored interval must be homogeneous: jiggler_s is 0 or equals
    // duration_s, never in between. Partial coverage cannot survive the
    // cross-machine union merge, which works on timestamps and needs a single
    // truthful start and end. See PRD §6.
    case "jigglerOn":
    case "jigglerOff": {
      const on = sig.kind === "jigglerOn";
      const closed = closeInto(s, "jiggler_toggle", cfg);
      const next: TrackerState = { ...closed.state, jiggler: on };
      return {
        state: next,
        effects: [
          ...closed.effects,
          { kind: "log", event: on ? "jiggler_on" : "jiggler_off" },
        ],
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
      const inputAge = o.lastInputMs === NO_SIGNAL
        ? sig.atMs - o.startedAtMs
        : sig.atMs - o.lastInputMs;
      if (anyLevelHolding(s) && inputAge > cfg.cameraOnlyMaxMs) {
        const closed = closeInto(s, "camera_cap", cfg);
        return { state: closed.state, effects: [...closed.effects, { kind: "log", event: "camera_cap" }] };
      }

      // A level signal still holds it open. Push the deadline out and keep the
      // interval alive — this is what carries a 50-minute meeting with no mouse.
      if (anyLevelHolding(s)) {
        const bumped: OpenInterval = { ...o, lastRealSignalMs: Math.max(o.lastRealSignalMs, sig.atMs) };
        const next = { ...s, open: bumped };
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
      return { state: closed.state, effects: [...closed.effects, { kind: "log", event: "tap_lost" }] };
    }

    // ── quit ────────────────────────────────────────────────────────────────
    // Leave the row OPEN in the journal. The next boot applies the identical
    // rule, so quit needs no special handling and cannot lose the tail.
    case "appQuit":
      return { state: s, effects: [{ kind: "journal", open: s.open }, { kind: "log", event: "quit" }] };
  }
}
```

---

## 4. The transition table

Every cell. `—` means no state change and no effects.

| Signal | `open = null` | `open`, no level held | `open`, camera or mic held |
|---|---|---|---|
| `boot` (nothing journalled) | cancel deadline | n/a | n/a |
| `boot` (journalled, fresh) | **resume same id**, arm | n/a | n/a |
| `boot` (journalled, stale) | **persist closed at `lastRealSignalMs`**, reason `crash_recovered` | n/a | n/a |
| `realInput`, not paused | **open** at `atMs`, source `input`, arm | extend `lastRealSignalMs` + `lastInputMs`, re-arm | same |
| `realInput`, paused | — | — | — |
| `cameraOn` / `micMeetingOn`, not paused | **open** at `atMs`, source `camera`/`mic` | extend `lastRealSignalMs`, start span | start span |
| `cameraOn` / `micMeetingOn`, paused | set level only | set level only | set level only |
| `cameraOff` / `micMeetingOff` | set level only | fold span, extend `lastRealSignalMs` | fold span, extend |
| `jigglerOn` / `jigglerOff` | set flag | **close** (`jiggler_toggle`), set flag | **close**, set flag |
| `pauseOn` | set flag | **close** (`pause`), set flag | **close**, set flag |
| `pauseOff` | clear flag | n/a | n/a |
| `deadlineFired`, gap < timeout | — | **re-arm only** | **re-arm only** |
| `deadlineFired`, gap ≥ timeout | — | **close** (`idle_timeout`) | extend and re-arm |
| `deadlineFired`, input age > camera cap | — | n/a | **close** (`camera_cap`) |
| `tapLost` | — | **close** (`tap_lost`) | **close** |
| `appQuit` | journal `null` | **journal, leave open** | journal, leave open |

**Read the `deadlineFired` rows carefully.** Three different outcomes from one signal is where the subtlety lives, and it is why the timer can be lazy: firing early is harmless because the reducer recomputes the real answer.

---

## 5. The deadline scheduler

`src/main/deadline.ts`. Not in `core/` — it owns a real timer — but it is the only impure part of the countdown, it is ~30 lines, and it is held to 100% line coverage.

```ts
type Fire = (firedAtMs: number) => void;

export interface Deadline {
  arm(atMs: number): void;
  cancel(): void;
  /** Test seam. Production passes the real clock and setTimeout. */
  readonly armedFor: number | null;
}

export function createDeadline(
  fire: Fire,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout = setTimeout,
  unschedule: (t: NodeJS.Timeout) => void = clearTimeout,
): Deadline {
  let timer: NodeJS.Timeout | null = null;
  let target: number | null = null;

  const clear = () => { if (timer) { unschedule(timer); timer = null; } target = null; };

  return {
    get armedFor() { return target; },
    cancel: clear,
    arm(atMs: number) {
      // LAZY: if a timer is already pending for at or after this moment, leave
      // it. Firing early is free — the reducer recomputes and re-arms. This is
      // what turns a 300-events/second mouse drag into zero timer syscalls.
      if (timer !== null && target !== null && target <= atMs) return;
      clear();
      target = atMs;
      // Clamp: setTimeout with a huge or negative delay is unreliable, and a
      // delay over ~24.8 days overflows to firing immediately, forever.
      const delay = Math.min(Math.max(0, atMs - now()), 6 * 60 * 60 * 1000);
      timer = schedule(() => { timer = null; target = null; fire(now()); }, delay);
    },
  };
}
```

**Why this survives sleep with no sleep-specific code.** A timer does not run while the machine is suspended. When it fires late, `fire(now())` reports the real wall-clock time, the reducer compares it against `lastRealSignalMs`, and closes at the pre-sleep signal. Shut the lid for three hours and the interval ends at your last keystroke before you shut it — with no `NSWorkspace` notification anywhere in the system, which also means App Nap, SIGSTOP, crashes and hard power-off are handled by the same three lines.

The 6-hour clamp exists so that a wake after a long sleep re-evaluates promptly rather than trusting a stale timer. `powerMonitor`'s `resume` also calls `arm()` again.

---

## 6. Camera and mic — levels into edges

`src/core/levels.ts`. The OS reports *state* ("a camera is in use"), not events. The reducer wants edges. This converts, and it is where the mic scoping from PRD §3.5 lives.

```ts
import { NO_SIGNAL, type Ms, type Signal } from "./types";

export interface LevelInput {
  readonly cameraInUse: boolean;
  readonly micInUse: boolean;
  readonly meetingAppRunning: boolean;
  readonly atMs: Ms;
}

export interface LevelState {
  readonly camera: boolean;
  readonly micMeeting: boolean;
  /** When the mic first went up. The 60-second floor is measured from here. */
  readonly micRisingAtMs: Ms;
}

export const initialLevels: LevelState = {
  camera: false, micMeeting: false, micRisingAtMs: NO_SIGNAL,
};

export function levelsToSignals(
  prev: LevelState, input: LevelInput, micMinCaptureMs: number,
): { next: LevelState; signals: Signal[] } {
  const signals: Signal[] = [];

  if (input.cameraInUse !== prev.camera) {
    signals.push(input.cameraInUse
      ? { kind: "cameraOn", atMs: input.atMs }
      : { kind: "cameraOff", atMs: input.atMs });
  }

  // THE CONJUNCTION. Mic alone is never a signal — dictation tools hold the
  // microphone more or less continuously and are not meetings. The OS tells us
  // the mic is captured but not by whom, so a running meeting app is the
  // available proxy. PRD §3.5.
  const micRisingAtMs = input.micInUse
    ? (prev.micRisingAtMs === NO_SIGNAL ? input.atMs : prev.micRisingAtMs)
    : NO_SIGNAL;

  const heldLongEnough =
    input.micInUse && micRisingAtMs !== NO_SIGNAL && input.atMs - micRisingAtMs >= micMinCaptureMs;

  // A two-second Siri invocation or a dictation blip never opens an interval.
  const micMeeting = heldLongEnough && input.meetingAppRunning;

  if (micMeeting !== prev.micMeeting) {
    signals.push(micMeeting
      ? { kind: "micMeetingOn", atMs: input.atMs }
      : { kind: "micMeetingOff", atMs: input.atMs });
  }

  return { next: { camera: input.cameraInUse, micMeeting, micRisingAtMs }, signals };
}
```

**Known and accepted:** because capture is reported system-wide, a dictation app capturing *while* Zoom happens to be running satisfies the conjunction. In that situation the owner is at the machine anyway and real input covers it, so the false positive costs nothing.

---

## 7. Tests

`src/core/reduce.test.ts`. These are the deliverable as much as the code is. Each maps to an acceptance gate in `docs/ROADMAP.md` M2.

### The ones that protect the close rule

| Test | Assertion |
|---|---|
| `closes at last signal, not at the timeout instant` | input at `T`, `deadlineFired` at `T + 15m + 3s` ⇒ `endedAtMs === T` |
| `never ends in the future` | for every persisted interval, `endedAtMs <= max(signal.atMs seen)` |
| `late delivery does not corrupt the end` | a `realInput` whose `atMs` is 5s older than `nowMs` still sets the end to `atMs` |
| `close is idempotent` | a second `deadlineFired` after closing emits no second `persist` |

### Signals

| Test | Assertion |
|---|---|
| `camera holds an interval past the deadline` | camera on, no input, `deadlineFired` at `T + 20m` ⇒ still open |
| `camera alone opens an interval` | idle 20m, `cameraOn` ⇒ open, `startSource === "camera"` |
| `camera-only cap closes it` | camera on, no input, fire past `cameraOnlyMaxMs` ⇒ closed, `endReason === "camera_cap"` |
| `mic needs a meeting app` | `micInUse` true, `meetingAppRunning` false ⇒ no signal emitted |
| `mic needs 60 seconds` | mic up for 30s with a meeting app ⇒ no signal; at 61s ⇒ `micMeetingOn` |
| `paused input is ignored` | `pauseOn` then `realInput` ⇒ no interval opens |

### The jiggler — homogeneity

| Test | Assertion |
|---|---|
| `jiggler toggle closes and reopens` | input, `jigglerOn`, input ⇒ **two** persisted intervals |
| `every interval is homogeneous` | for every persisted interval, `jigglerMs === 0 \|\| jigglerMs === durationS * 1000` (±1s rounding) |
| `synthetic input never reaches the reducer` | the fake `SignalSource` emitting a stamped event produces **no** `realInput` signal (this is really an `IMPL_NATIVE` test; assert it here too, because the consequence is 24-hour workdays) |

### Recovery

| Test | Assertion |
|---|---|
| `stale journal closes at the pre-sleep signal` | journalled with `lastRealSignalMs = T`, boot at `T + 3h` ⇒ `endedAtMs === T`, reason `crash_recovered` |
| `fresh journal resumes the same id` | boot at `T + 5m` ⇒ open, `id` unchanged |
| `quit leaves the row open` | `appQuit` ⇒ a `journal` effect with the interval, and **no** `persist` |
| `tapLost closes at the last trusted signal` | ⇒ `endedAtMs === lastRealSignalMs`, reason `tap_lost` |

### The property test

The one that catches what the table misses.

```ts
import fc from "fast-check";
import { reduce, initialState } from "./reduce";

const arbSignal = (t: number) =>
  fc.oneof(
    fc.record({ kind: fc.constant("realInput" as const), atMs: fc.constant(t),
                keys: fc.nat(5), mouse: fc.nat(5) }),
    fc.record({ kind: fc.constantFrom("cameraOn" as const, "cameraOff" as const,
                                      "micMeetingOn" as const, "micMeetingOff" as const,
                                      "jigglerOn" as const, "jigglerOff" as const,
                                      "pauseOn" as const, "pauseOff" as const,
                                      "deadlineFired" as const, "tapLost" as const),
                atMs: fc.constant(t) }),
  );

it("an interval never ends after the last signal that could have extended it", () => {
  fc.assert(fc.property(
    // Monotonically increasing timestamps, which is what the tap guarantees.
    fc.array(fc.nat(120), { minLength: 1, maxLength: 200 }),
    fc.array(fc.nat(9), { minLength: 1, maxLength: 200 }),
    (gaps, picks) => {
      let s = initialState, t = 1_700_000_000_000;
      let maxSeen = 0;
      let n = 0;
      const cfg = { idleTimeoutMs: 900_000, minIntervalMs: 90_000,
                    cameraOnlyMaxMs: 21_600_000, newId: () => `id-${n++}` };
      for (let i = 0; i < gaps.length; i++) {
        t += gaps[i]! * 1000;
        const sig = fc.sample(arbSignal(t), { seed: picks[i]! , numRuns: 1 })[0]!;
        maxSeen = Math.max(maxSeen, t);
        const r = reduce(s, sig as never, cfg, t);
        s = r.state;
        for (const fx of r.effects) {
          if (fx.kind === "persist") {
            // The invariant. If this ever fails, a break donated time to the week.
            expect(fx.interval.endedAtMs).toBeLessThanOrEqual(maxSeen);
            expect(fx.interval.endedAtMs).toBeGreaterThanOrEqual(fx.interval.startedAtMs);
            expect(fx.interval.durationS).toBeGreaterThanOrEqual(0);
          }
        }
      }
    },
  ), { numRuns: 500 });
});
```

### Coverage

`src/core/**` is held to **100% statements and functions, 95% branches** in `vitest.config.ts`. It is pure code with no I/O, no network and no clock. There is no legitimate reason for a gap, and a gap here is a gap in the only part of the product that cannot be spot-checked by looking at the screen.
