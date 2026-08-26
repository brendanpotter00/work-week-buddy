# Work Week Buddy — Product Requirements

**Status:** specification. Nothing is built.
**Users:** one — the repo owner. Two or more Macs (personal, work, and whatever comes next).
**Version:** v1.

---

## 1. The problem

I don't know how many hours I actually work in a week. Every tool that could tell me requires me to start a timer, tag a project, or categorize my day — so I stop using it within a week and the data is worthless.

I want a number I trust, produced by a thing I never interact with.

## 2. What success looks like

- I open the dashboard on a Friday and the weekly total matches my memory of the week to within about ten minutes.
- I never started a timer.
- Two years from now the history is still there, and I never ran a backup command.

## 3. Core mechanic

### 3.1 Signals

A **signal** is evidence a human is present. There are exactly two:

| Signal | Source | Notes |
|---|---|---|
| Real input | keyboard or mouse, delivered by a listen-only event tap | Includes modifier-only presses (shift/cmd/ctrl/fn), which arrive on a separate channel — see §3.6 |
| Camera in use | any camera in use by any process | Camera on = meeting = work, per the brief. No exceptions. |
| Microphone in use | mic captured by **any** process for at least 60 seconds | Not scoped to meeting apps — see §3.5. Covers audio-only calls, camera-off calls, dictation and recording alike. |

Explicitly **not** signals: our own jiggler, the keep-awake toggle, app UI interaction, network activity, running processes on their own, window titles.

### 3.2 The interval state machine

```
Idle  --(signal)-->  Open        interval starts at that exact event timestamp
Open  --(signal)-->  Open        countdown pushed back out to 15:00
Open  --(15 min, nothing)-->  Idle    interval ENDS AT THE LAST REAL SIGNAL
```

**The load-bearing rule, stated once:**

> An interval always ends at the timestamp of the last real signal. Never at the moment the countdown fired. Never `now`.

This is enforced in code and in tests, not by convention. Getting it wrong donates 15 phantom minutes to every break, silently.

### 3.3 The countdown

One timer, armed only while an interval is open.

It is **lazily re-armed**: it is not reset on every event. When it fires it recomputes `lastRealSignal + 15min - now()` and either closes the interval or re-arms. Observable behavior is identical to "reset on every input", but a 300-events-per-second mouse drag does not become 300 timer operations per second.

This also makes sleep, App Nap, clock steps and NTP corrections self-healing: a timer that fires late compares wall-clock times and gets the right answer anyway.

### 3.4 Camera participation

The camera is a *level*, not an *edge* — there is no "camera event" to reset a timer with. Camera-on and camera-off are converted into synthesized signal edges that the same state machine consumes.

A camera-only interval (in a meeting, not touching the machine) is capped, so a forgotten Zoom window or a virtual camera left running cannot log a 14-hour day.

### 3.5 Microphone — in use means working

**The rule, in one line:**

> the microphone has been captured for at least 60 seconds

That is the whole rule. Not "captured by an app on a list". Not "captured while something else is running". Captured.

**What the OS actually tells us:** whether the microphone is being *captured* — not what it hears, and not by whom. Ambient noise, music and video playback are all invisible to this.

**The 60-second floor is the only qualifier, and it stays.** A capture shorter than a minute never opens an interval, so a Siri invocation, a "Hey" to a voice assistant or a two-second dictation blip is ignored. The floor is invisible to the user and not configurable — there is nothing here for anyone to get wrong.

#### The meeting-app distinction was removed, and why

This used to be a conjunction: the mic counted only alongside a running meeting application, backed by a seeded allowlist (Zoom, Slack, Teams, Webex, Discord) and a seeded ignore list of dictation tools (Wispr Flow, OpenWhispr), both user-editable in Settings. All of that is gone — the two lists, the two settings keys, the running-process check, and the conjunction itself.

The reason it went:

- **The premise was wrong.** The conjunction assumed a held microphone might not be work. In practice the owner holds the microphone to dictate, to record, and to take calls, and all three are working. Nobody has the mic open while not at the machine.
- **It produced silent false negatives, which is the failure this product exists to avoid.** A day spent dictating recorded as idle, and nothing anywhere said so.
- **It was configuration that could not be got right.** Miss a bundle id and a 50-minute call reads as idle; the lists had to be maintained forever against an open-ended world of apps, by hand, in a settings pane, to answer a question that turned out not to need answering.
- **The OS could not answer it properly anyway.** Capture is reported system-wide, never per-process, so "a meeting app is running" was only ever a proxy — and one that fired for a dictation tool that happened to be running next to an idle Zoom.

**What we gave up, stated plainly:** a microphone captured by something that genuinely is not work — a background process, another person's remote session — now counts. Two things bound that: the 60-second floor, and the same cap §3.4 puts on the camera, so a mic left open with nobody at the machine stops counting rather than logging a 14-hour day.

### 3.6 The jiggler

Optional, **off by default**, behind a toggle in the menu bar.

- It posts a **null event** — an event type carrying no coordinates — so it resets the system idle clock without being able to move the cursor.
- Our events are stamped before posting and identified on the way back by two independent fields.
- **A jiggle is never a signal.** It cannot open, extend, or keep alive an interval.

Every interval records `jiggler_s` — how many seconds of that interval ran with our jiggler on. This makes the policy question in §6 a display-time filter that can be changed retroactively, forever.

### 3.7 Failure modes that must be loud, not silent

These are the ones that produce plausible-looking wrong numbers rather than errors. Each must fail loudly.

| Failure | Symptom if silent | Required behavior |
|---|---|---|
| Keyboard permission not actually granted | A whole class of typing invisible; hours come out slightly low, forever | Assert the granted event mask at boot; red banner if keyboard bits are missing |
| Modifier-only keys not in the mask | Same as above | Startup assertion |
| Event tap silently disabled by macOS | Reads as "he never typed again"; every interval closes 15 min early and the day vanishes | Read-only watchdog; recreate the tap; log a `tap_lost` row |
| Our jiggle misclassified as human input | Work hours inflated with fake time, 24-hour workdays | The self-test round-trips a tagged jiggle and asserts it is identified as ours. `scripts/install.sh` gates the install on `--selftest`, and **main runs it again every time the jiggler is switched on** — silent on a pass, and on a failure it switches the jiggler straight back off and raises `selftest_failed` in the degraded banner and the tray. It is not run on any other path: the risk only exists while the jiggler is running, and the jiggler ships off. |
| Interval written with `end = now` | Every break donates 15 minutes | Unit test asserts close-at-last-signal; property test over arbitrary signal streams |

## 4. The dashboard

One page. Notion-flavored, light and dark. Reads the local mirror only, so it paints instantly and works offline.

It shows:

- **Live status** — working or idle, current interval length, which machine, when the last signal was
- **This week** — total hours, average interval length, longest interval, days worked
- **All time** — average interval, longest ever, average week
- **Activity heatmap** — hours per day, 12 months, GitHub-style squares, 5 shades
- **This week bar chart** — seven bars
- **By machine** — hours per machine this week, with meeting hours and jiggler hours broken out

Empty/first-run state renders every card at full size with `—`, so the grid does not reflow when data arrives.

The reference implementation is committed under `design/` and is the visual acceptance target.

## 5. The menu bar

The always-on surface. The dashboard window may never be opened for a week at a time.

- Title shows a live number (see open decision D3)
- Dropdown: current interval, today, this week, machine, and three toggles — **Jiggler**, **Keep awake**, **Pause tracking**
- Tracking continues with the dashboard window closed. The title is driven from the main process, never from the renderer.

## 6. Decisions taken

| # | Question | Decision |
|---|---|---|
| **D1** | With the jiggler ON and the owner actually typing, does that typing count as work? | **(a) No — jiggler ON means off the clock.** Chosen by the owner over the recommendation. |
| **D2** | Keep the 5-minute read-only watchdog tick? | **Always on.** |
| **D3** | What does the menu-bar title show? | **Hours today.** ↺ Revised — this was "hours this week" until the owner reversed it. The week total and the current interval live in the dropdown. |
| **D4** | Is ~209 MB resident acceptable? | **Accept.** TypeScript is worth it. |

### D1, precisely — because "off the clock" has more than one implementation

Tracking **does not stop** when the jiggler is switched on. What changes is scoring.

**Toggling the jiggler is an interval boundary.** Switching it on closes the current interval at the last real signal and opens a new one; switching it off does the same. Every stored interval is therefore *homogeneous* — either entirely jiggler-covered (`jiggler_s = duration_s`) or entirely jiggler-free (`jiggler_s = 0`). Never partial.

That one rule buys both properties we need:

- **(a) is a clean filter.** Drop intervals where `jiggler_s > 0`, before the cross-machine union merge. Partial credit would not compose with that merge, because merging works on timestamps and a partially-covered interval has no single truthful start and end.
- **It stays fully reversible.** The covered intervals are still on disk, so switching to (b), (c) or (d) later re-scores the entire history with one bind parameter. Had tracking simply been suspended while jiggling, that history would not exist and the choice would have been permanent.

**Known consequence, accepted:** under (a), a meeting attended with the jiggler running does **not** count, even though §3.1 says a camera in use always means work. These two rules genuinely conflict, and D1 wins where they overlap. If that turns out to be wrong in practice, switching to option (c) is a one-parameter change and rescores all history.

**Implementation:** `v_countable` in `docs/DATA_MODEL.md` carries this as a bind parameter. It lives there and nowhere else.

## 7. Settled requirements

| Requirement | Decision |
|---|---|
| Idle timeout | 15 minutes, adjustable 10–15 without touching history |
| Two machines active at once | Counts **once** (union of wall-clock time). Per-machine breakdown shown separately with the overlap visible |
| Camera alone opens an interval | Yes |
| The 15 idle minutes | Not counted. Dashboard shows what crediting 2/5/10 minutes would do, so it can be decided from real data later |
| Minimum interval | 90 seconds. Shorter rows are kept as evidence, excluded from headline numbers |
| Week starts | Monday |
| Machines | User-extensible. Each install names itself on first run; nothing is hardcoded to two |
| Deleting history | Never. Rows are excluded, never removed |
| Editing history | Not in v1 |

## 8. Acceptance — the honest bar

The number is not trustworthy until it has survived a **two-week soak on both Macs**:

- no `tap_lost` rows
- `crash_recovered` count ≤ 2
- weekly fingerprint matches every week
- three work sessions the owner remembers, spot-checked against recorded intervals, matching to within two minutes

**Do not present the headline number as correct before this passes.**
