# Roadmap

Eight milestones. Every gate is a script or an observation, not a judgment call.

Rough scale: a handful of agent-days, plus about two hours that only a human can do (creating the Cloudflare resources, trusting a certificate, granting permissions on both Macs, and closing a laptop lid to watch what happens).

---

## M0 — Work-Mac go/no-go spike · **before any code** · ~2–3 hours

**This is the largest open risk in the project and it cannot be answered from the personal Mac.**

Build a throwaway self-signed bundle. Put it in `/Applications` on the **work** Mac.

**Gate:**
- (a) It can be added to **Input Monitoring** and **Accessibility** — no MDM configuration profile blocks self-signed bundles.
- (b) `curl https://<worker>.workers.dev/health` returns 200 through the corporate network and proxy.

**If (a) fails**, keyboard tracking is impossible on the machine that generates most of the data, and the product changes shape. **If (b) fails**, the vendor changes. Nothing else starts until this passes.

---

## M1 — The native layer

`native.ts` (~45 koffi declarations) plus boot assertions.

**Gate, in the packaged app:**
- (a) the granted event-tap mask includes the keyboard bits
- (b) at least one real event arrives within 60 s of launch
- (c) a tagged null jiggle round-trips and is identified as ours — including a `typeof === 'number'` assertion on the field read
- (d) a deliberate 2-second block in the callback produces `kCGEventTapDisabledByTimeout`, is caught, and the tap is re-enabled
- (e) a run-loop mode A/B test asserts events arrive with both modes registered
- (f) grant Accessibility → rebuild → confirm the grant survived

---

## M2 — The interval machine

`reduce(state, signal, cfg) → {state, effects}`. Zero imports from `electron`, enforced by lint.

**Gate:**
- (a) closes at `lastRealSignal`, never at the timeout instant
- (b) synthetic input never advances `lastRealSignalMs`
- (c) camera-on holds an interval open past the deadline
- (d) sleep closes at `lastRealSignalMs`, not at wake time
- (e) toggling the jiggler closes the current interval and opens a new one, so no stored interval is ever partially jiggler-covered
- (f) a property test over arbitrary signal streams asserts `endedAt <= lastRealSignalWithin(interval)` **always**

---

## M3 — Local store

`node:sqlite`, the open-interval journal, crash recovery.

**Gate:**
- (a) `kill -9` mid-interval, restart → closed at `last_signal_ms` with `end_reason='crash_recovered'`, ≤30 s lost
- (b) two instances cannot start
- (c) a scheduler test stepping the deadline 4 hours into the past fires immediately on `resume`

---

## M4 — Cloud round trip

D1 + Worker + flush/pull/fingerprint.

**Gate:**
- (a) airplane mode for 1 hour, 6 intervals recorded, reconnect → all 6 land, none duplicated
- (b) a forced mid-flush kill re-flushes with **zero** duplicates
- (c) the pull-watermark overlap test skips no rows
- (d) the fingerprint matches
- (e) the Worker rejects a request bearing the other machine's token
- (f) a `DELETE` is impossible by route surface

---

## M5 — Menu bar, toggles, onboarding

Tray title showing hours this week; Jiggler, Keep-awake and Pause toggles; the permission onboarding flow.

**Gate:**
- (a) with the jiggler on and display sleep set to 1 minute, the display does **not** sleep for 10 minutes **and the cursor never moves one pixel**
- (b) typing during that window is still recorded, and lands in an interval marked as jiggler-covered
- (c) revoking Input Monitoring produces a loud degraded state, not a silent zero
- (d) `pmset -g assertions` shows exactly one assertion while keep-awake is on, and none after
- (e) closing the dashboard window does not stop tracking or freeze the tray title

---

## M6 — Dashboard

Port `design/App.reference.tsx`.

**Gate:**
- (a) `import "react-activity-calendar/tooltips.css"` present, tooltips styled
- (b) `colorScheme` passed explicitly so the heatmap follows the app theme, not the system
- (c) the six queries in `docs/DATA_MODEL.md` drive real data
- (d) closing the window recovers the expected memory
- (e) no console errors; CSP allows the inline styles Recharts and the tooltip library write
- (f) screenshotted in the **built app**, not a browser

---

## M7 — Both Macs in production

**Gate:**
- (a) identical designated requirement on both Macs (`codesign -d -r-` prints the same leaf hash)
- (b) rebuild + reinstall does **not** require re-granting permissions
- (c) the week-1 backup file exists in the iCloud/Documents path
- (d) simulated cloud loss: wipe the D1 table, mark local rows unsynced, and the mirror rebuilds it completely
- (e) the silence alarm fires with the clock pushed 72 h
- (f) Mac B shows Mac A's full history within 5 minutes
- (g) **a real lid-close sleep cycle is observed** — 3 minutes gives one continuous interval; 2 hours closes truncated to the pre-sleep signal

---

## Soak — two weeks, both Macs

- no `tap_lost` rows
- `crash_recovered` count ≤ 2
- fingerprint matches every week
- three work sessions the owner remembers, spot-checked against recorded intervals, matching to within two minutes

**Do not present the headline number as correct before this passes.**

---

## Human-only steps

| When | What |
|---|---|
| M0 | Install a throwaway bundle on the work Mac and try to grant it two permissions |
| M0 | Create the Cloudflare account, D1 database, and Worker; put the per-machine secrets |
| M1 | Create the self-signed certificate and mark it trusted — the trust dialog cannot be scripted |
| M1 | Grant Input Monitoring and Accessibility on both Macs |
| M7 | Close the laptop lid and watch what happens. Nothing automates this, and it is the one behavior with no empirical grounding |
| Soak | Two days of real use, then eyeball "hours this week" against memory before trusting it |
