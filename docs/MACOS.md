# The macOS layer

Every claim here was measured on **macOS 26.5.1 (build 25F80), arm64**, in August 2026. Where something was *not* verified, it says so.

Keep all of this in one small `native.ts`. koffi prototypes are string-typed, so a wrong signature is a segfault rather than a compile error — this is the one file in the repo where a typo is not caught by the compiler. Exercise every declaration once in a boot test, then stop touching it.

---

## 1. Real input — a listen-only event tap

```
CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                 kCGEventTapOptionListenOnly, mask, callback, ctx)
```

**Mask must include type 12, `kCGEventFlagsChanged`.** Modifier-only presses — shift, cmd, ctrl, fn — arrive *only* as FlagsChanged. Without that bit, a whole class of typing is invisible, hours come out slightly low, and nothing errors.

Event type numbers:

```
leftMouseDown=1  leftMouseUp=2  rightMouseDown=3  rightMouseUp=4
mouseMoved=5     leftMouseDragged=6  rightMouseDragged=7
keyDown=10       keyUp=11       flagsChanged=12
scrollWheel=22   tabletPointer=23    tabletProximity=24
otherMouseDown=25  otherMouseUp=26   otherMouseDragged=27
```

### Two silent-death traps — both reproduced

**1. Run-loop mode.**

```
source added ONLY to kCFRunLoopCommonModes  →  {"events": 0}     ← silently dead
source added ONLY to kCFRunLoopDefaultMode  →  {"events": 104}   ← works
```

Add it to **both**: Default so events flow, Common so it survives menu-tracking and modal nested modes.

**2. Mask stripping.** A tap created without the keyboard permission returns non-NULL with the keyboard bits silently removed. Verify with `CGGetEventTapList` at boot and assert the keyboard bits survived. Do not trust the create call.

### The mode that is NOT self-reporting, whatever this section used to say

This section used to read: *"A slow callback triggers `kCGEventTapDisabledByTimeout` — measured, a 1.6 s block disabled the tap. It arrives as a callback with type `0xFFFFFFFE`. Handle it before any field read, then `CGEventTapEnable(tap, true)`."*

The first sentence is right. **The second is not reliable, and the app shipped believing it was.** Only the *disable* was ever measured. The notice arriving, and the re-enable working, were prescribed and never observed — `setDebugStallMs` sat in `native.ts` from M1 onwards and nothing ever called it, so M1 gate (d) never ran.

Measured 2026-08-21, arm64, macOS 26.5.1, twice, inside the real Electron main process (`--selftest`, M1 gate d):

```
a 2500 ms block in the callback disables the tap  →  yes — notices 0, enabled=false
how the app found out the tap was down           →  NO disable notice
the tap comes back with no user interaction      →  reenabled: CGEventTapEnable took
events resume after the recovery                 →  seen
```

**`notices 0`.** macOS disabled the tap and said nothing, and was still saying nothing 600 ms later. In a standalone harness the notice did eventually arrive — but only when the *next event* was posted, after three full seconds of pumping the run loop produced none. The notice rides along with traffic.

Two consequences, and they are the whole reason the app was measuring nothing:

1. **The disable-notice callback cannot be the recovery mechanism.** The one channel that could tell us we have gone deaf is the channel we have gone deaf on. Something has to ASK, on a clock — `reviveTap()` plus the watchdog's 2-second liveness beat.
2. **A block does not kill the tap on its own.** It takes a block *with traffic queued behind it*. A lone 5-second block with nothing waiting left the tap enabled; the same block with 60 events queued killed it. That is why the gate posts a burst.

Still true and still load-bearing: on types `0xFFFFFFFE` / `0xFFFFFFFF` the event carries no meaningful fields, so handle the notice **before any field read**. And still issue the `CGEventTapEnable(tap, true)` — it is free and it sometimes works. Just verify it, and never rely on it.

### Inside Electron it is genuinely push

```
electron main process, source in DefaultMode, NO drain timer:
  {"DRAIN": 0, "realEvents": 197, "ourSynthetic": 3}
```

Electron's main process runs a real `CFRunLoop`, so Chromium's own pump dispatches the tap source. Plain Node has no main-thread CFRunLoop and would need `CFRunLoopRunInMode` on an interval.

### Cost

```
8s with mouseMoved in the mask (worst case):
  events 86 · cpu 0.15% · avg callback 1.6 µs · rss 41.3 MB
idle baseline: cpu 0.01% · rss 37.4 MB
```

### Timestamps

`CGEventGetTimestamp` is **nanoseconds since boot, exact**. Take interval end times from the event, never from `Date.now()` at receipt.

Verified with a deliberately abusive 3-second drain: events queued losslessly in the mach port and their timestamps were still correct, with receipt delayed 2.4 s and 5.4 s.

---

## 2. Telling our own jiggle apart

```ts
CGEventSourceSetUserData(src, 0x57574B31n);            // stamp before posting

const isOurs = field(ev, 42 /*kCGEventSourceUserData*/)      === 0x57574B31
            && field(ev, 41 /*kCGEventSourceUnixProcessID*/) === process.pid;
```

Measured over 422 events:

```
real:  srcPid=0      userData=0
ours:  srcPid=59014  userData=0x57574b31
```

**Three traps:**

1. **`kCGEventSourceStateID` (field 45) is NOT a discriminator.** A `HIDSystemState` source reads back `1` — identical to real input.
2. **Read the field as a number.** koffi returns int64 as a JS Number; comparing against a BigInt literal is always false, which silently classifies our own jiggle as human input and inflates hours with fake time. Assert `typeof === 'number'`.
3. **Post to the same tap location the tap listens at.** An HID-posted event is invisible to a session tap, so the filter never sees it.

---

## 3. The jiggler

Post **`kCGEventNull`** — an event type that carries no coordinates and therefore *cannot* move the cursor.

Measured, it defeats the idle timer exactly like a mouse move:

```json
{"hidIdleBefore": 19.36, "hidIdleAfter": 0.443,
 "secondsSincePost": 0.436, "expectedIfNOTreset": 19.796,
 "nullEventResets_HIDIdleTime": true}
```

The reset is **asynchronous** — a read taken immediately after `CGEventPost` returned still showed 6.457 s, then 300 ms later showed 0.2995 s.

This is strictly better than a mouse jiggler: no cursor drift, no accidental drags, nothing fighting the pointer.

### Proving that on a Mac somebody is using

"The cursor did not move" is a real promise and `--selftest` checks it, but the first version of that check was wrong in a way worth recording, because the failure mode is not the usual one for this project — it was **loud and wrong**, not silent and wrong.

It read the cursor, posted, read it again, and failed if the two differed. That is a correct measurement of an idle Mac. `--selftest` never runs on an idle Mac: `install.sh` invokes it one line after a command the owner typed, and `runtime.ts` invokes it the instant the jiggler is switched on. Measured on the owner's machine, twice, minutes apart:

```
FAIL cursor did not move · -974.13671875,495.265625 → -974.37890625,495.265625   (37 real signals in the run)
FAIL cursor did not move · -1293.9921875,826.9453125 → -1271.59375,816.27734375  (14 real signals in the run)
```

A quarter of a pixel in the first one. Both runs passed every check that actually discriminates. The install stopped, the LaunchAgent was never written, and the tracker sat there not running until the gate was bypassed by hand. **A safety gate that fails during normal use trains its owner to bypass it**, which is strictly worse than not having the gate.

The fix is not to delete the check or to ask the owner to keep his hands still. It is that the tap already knows who moved the pointer:

| cursor | foreign pointer events in the window | verdict |
|---|---|---|
| moved | none | **FAIL** — the only thing that moved it was us |
| still | none | **pass** |
| either | one or more | **void** — measure again |
| — | void every time | **could not be measured** |

Load-bearing, and the reason this cannot hide a real regression: **our own tagged jiggle never reaches that counter**, because the callback returns at the `isOurs` branch above it. A jiggler that really does drag the cursor therefore produces *clean* windows with movement in them, and fails on the first one. Contamination can cost it an attempt; it cannot buy it a pass. Keystrokes are excluded for the same reason from the other direction — a key press cannot move a cursor, and the human running `install.sh` has their hands on the keyboard by definition.

Each attempt first waits for the pointer counter to go flat for 120 ms, which costs an idle machine nothing and finds the gap on a busy one. Six attempts, then "could not be measured" — which is neither `ok` nor `FAIL` in the transcript, does not stop the install, and does not report green. See `src/native/cursor-stillness.ts`; the decision logic is behind a probe interface and is the one part of `--selftest` with real unit tests.

Measured 2026-08-25, arm64, macOS 26.5.1, against the real tap, with a synthetic hand posting untagged `kCGEventMouseMoved` at 100 Hz (a trackpad's own report rate) to stand in for a person:

```
old check, ~100 Hz of movement    →  FAIL cursor did not move · -653.09,609.00 → -652.59,609.00   exit 1
new check, ~100 Hz for 2 s        →  ok   · 2 attempts, nothing else moving                       exit 0
new check, ~100 Hz for 9 s        →  ?    could not measure: foreign pointer input in all 6        exit 0
new check, jiggler warps 1 px     →  FAIL · the jiggle moved it — zero foreign pointer events      exit 1  (4 of 4 runs)
new check, machine merely in use  →  ok   · 1 attempt                                              exit 0  (6 of 6 runs, 1–63 signals)
```

Half a pixel is what the old check died on, which is the same order as the quarter-pixel that failed the owner's install. The regression row is the one that matters: a `postJiggle` patched to `CGWarpMouseCursorPosition` one pixel — a warp posts no event, so the window stays clean, which is exactly what a real regression looks like from the check's side — failed **every** run, including runs with 39, 45 and 107 real signals arriving. Verdicts came in 1–3 attempts at up to 208 signals; only 355 signals, which took saturating the tap on purpose, ran the budget out.

**Corollary, and it is why the watchdog is read-only:** since even a null event resets the idle clock, there is no side-effect-free canary. Any periodic self-probe would double as an always-on jiggler — no screensaver, no display sleep, permanently green in Slack.

---

## 4. Camera in use

CoreMediaIO: enumerate `kCMIOHardwarePropertyDevices` on `kCMIOObjectSystemObject`, then read `kCMIODevicePropertyDeviceIsRunningSomewhere` per device, **OR'd across all devices** (this machine has a built-in camera *and* an external one).

Verified from an ad-hoc-signed, hardened-runtime app bundle whose own camera authorization status was `notDetermined`: the property flipped `0 → 1 → 0` exactly bracketing another process's capture. **No prompt appeared, no camera light, and no TCC row was written.**

**Hard boundary, non-negotiable:** under App Sandbox the CMIO device list returns **zero devices** unless the camera entitlement is declared. Therefore: **never enable App Sandbox, and never ship to the Mac App Store.**

Note: the first CMIO connection powers the camera image processor for about 4 seconds. A long-lived process pays this once — which is why the polling lives in-process rather than in a helper invoked per check.

**Not verified:** the property *listener* registers cleanly (`OSStatus 0`, zero permissions) but was never observed actually firing, because that needs the webcam on. There are reports of spurious and cross-process-leaked callbacks on Apple Silicon. Correctness is therefore anchored on the 5-minute property re-read — the listener could be entirely broken and the only symptom would be up to 5 minutes of latency on camera-opens-an-interval.

---

## 4b. Microphone in use

CoreAudio, the exact mirror of the camera pattern: enumerate audio devices and read `kAudioDevicePropertyDeviceIsRunningSomewhere` per input device, OR'd across them. Expected to need **no permission**, same as the camera — **verify this in M1 rather than assuming it**, because the microphone TCC bucket is stricter than the camera's for actual capture.

**It reports capture, not sound.** Ambient noise, speaker output, music and video playback do not register. It also does **not** report which process is capturing, exactly like the camera.

**That last point no longer matters.** Mic-in-use is a work signal on its own — see PRD §3.5. There was once a conjunction with a running-application enumeration, so that dictation could be told apart from a call; it is gone, and so is the enumeration. Nothing in this layer asks what is running, and there is no NSWorkspace or process-list call anywhere in the app (see §7 and IMPL_NATIVE's forbidden list, which now holds for a second reason).

The only qualifier left on the mic is a **60-second floor**, and it lives in `src/core/levels.ts` where it can be tested with arithmetic. This directory reports the level and nothing else.

## 5. Keep awake

`IOPMAssertionCreateWithName` with `PreventUserIdleSystemSleep` + `PreventUserIdleDisplaySleep`, held in-process, released on toggle-off and kernel-released on process death.

```
create rc=0 assertionID=38450
pmset -g assertions  →  visible by name, count 1
after release        →  gone
```

Electron's `powerSaveBlocker` does reach the same API internally and is acceptable.

**Explicitly not** `spawn("/usr/bin/caffeinate")` — that pattern orphans child processes that outlive the app, and it is blocked from a sandboxed build anyway. An in-process assertion is released by the kernel on process death.

**Toggling keep-awake is never a work signal.**

---

## 6. Permissions

| Capability | TCC service | Settings pane | Preflight (no prompt) | If denied |
|---|---|---|---|---|
| Keyboard in the tap | `kTCCServiceListenEvent` | Input Monitoring | `CGPreflightListenEventAccess()`, `IOHIDCheckAccess(1)` | Tap returns non-NULL with keyboard bits stripped. Caught by the mask assertion → loud banner. Mouse + camera keep working. |
| Mouse in the tap | none | — | — | n/a |
| `CGEventPost` (jiggler) | `kTCCServicePostEvent` | Accessibility | `CGPreflightPostEventAccess()`, `AXIsProcessTrusted()` | Jiggler disabled with a tooltip. **Tracking unaffected.** |
| Camera-in-use | **none** | — | — | n/a |
| Keep-awake | **none** | — | — | n/a |

These are **independent** TCC rows. Having one does not imply the others.

`CGEventPost` **fails silently** without Accessibility — cursor delta 0, no error, no exception. Gate every jiggle on `AXIsProcessTrusted()`. A toggle that appears on but does nothing is the failure mode to design against.

**Honest caveat, unsettled:** every tap created during research inherited the terminal's existing grants, so **the denied path was never exercised**. Worse, which bucket governs keyboard bits is genuinely disputed — Apple's own `CGEvent.h` attributes them to Accessibility, current community and vendor documentation to Input Monitoring. So the app requests **both**, preflights **both**, and decides by inspecting the granted mask rather than trusting either doctrine.

---

## 7. Things that do not work, so nobody retries them

| Thing | What happens |
|---|---|
| `CGEventSourceSecondsSinceLastEventType` | **Reset by our own jiggler at every tap location.** Sawtooths 0.06 → 4.25 → 0.06 s while the user is completely idle. ESLint-banned, along with Electron's `powerMonitor.getSystemIdleTime()`/`getSystemIdleState()`, which wrap it. |
| `ioreg` `HIDIdleTime` | Same pollution. Fine as a diagnostic, useless as a signal. |
| `kCGEventSourceStatePrivate` | `CGEventSourceSecondsSinceLastEventType` with it **blocks forever** on macOS 26.5.1. Never call it. |
| Any `CGEventSource*` call in a sandbox | Hangs forever — no WindowServer connection. The app must run as a GUI-session app, never a LaunchDaemon. |
| `uiohook-napi` | Event payload has no source pid or userData, so it cannot tell our jiggle from a human. Also `uIOhook.stop()` hung past a 2-minute timeout. |
| App Sandbox | CMIO device list returns zero devices. Camera detection dies. |

---

## 8. Not yet verified — carry these into M1

- Literal `kCGEventKeyDown` (type 10) delivery through this tap. Only `kCGEventFlagsChanged` (type 12) was observed, because synthesizing keystrokes would have typed into the owner's active window. Confidence is high and the mask assertion covers the permission half, but the delivery half is inferred.
- The camera property listener actually firing (§4).
- The denied-permission path and the first-run prompt flow (§6).
- Sleep and wake behavior end to end. This machine had not slept in 10+ days of retained power logs, so nobody has watched a real lid-close cycle. **This is the most likely source of a post-ship bug.**
- `kCGEventTapDisabledByUserInput` (`0xFFFFFFFF`) has never been observed at all. The recovery path treats it identically to `ByTimeout` and there is a unit test for that, but no real one has ever been produced on this hardware.
- **What actually blocked the main thread for 4718 ms** in the owner's `wwb.log` on 2026-08-20. Ruled OUT by measurement: App Nap / Chromium background throttling of the main process (70 s at 25 events/s, dock hidden, no window, nothing focused → worst 1-second-timer gap 8 ms, `setImmediate` never late, zero disable notices), and the camera/mic HAL walk in `probe()` (timed in `--selftest`: 0 ms, 1 ms, 0 ms). The one main-thread block that WAS on the tap path — the inline `drain()` in the callback, which ran a synchronous SQLite write — has been removed. The rest is now instrumented rather than guessed: `worstDrainLagMs` records how long the Node loop was held, and the watchdog names the probe if it takes more than 750 ms.

### 8.1 Ruled out, so nobody spends the afternoon on it again

- **App Nap does not throttle the Electron main process here.** Measured as above. "It only counts when the window is focused" is not the OS backgrounding us.
- **The `uint32_t` in the `CGEventTapCallBack` prototype is correct.** `0xFFFFFFFE` arrives as `4294967294`, `typeof number`, and `=== 0xfffffffe` is true. A signed prototype would have made the comparison silently false; it is not signed.
- **`event` is non-NULL on a disable notice** in every observation so far, so the `if (event === null) return 0n` guard at the top of the callback is not eating it.
- **`--doctor` reporting `grantedMaskHex: 0x0` and `keyboardBitsGranted: false` means nothing.** That process never installs a tap. It now says "not probed in this process" instead, because the old output reads exactly like a denied permission and cost two rounds of debugging.
