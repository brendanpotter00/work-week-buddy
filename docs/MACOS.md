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

### The self-reporting mode

A slow callback triggers `kCGEventTapDisabledByTimeout` — measured, a 1.6 s block disabled the tap. It arrives as a callback with type `0xFFFFFFFE`. Handle it **before any field read**, then `CGEventTapEnable(tap, true)`.

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

**Corollary, and it is why the watchdog is read-only:** since even a null event resets the idle clock, there is no side-effect-free canary. Any periodic self-probe would double as an always-on jiggler — no screensaver, no display sleep, permanently green in Slack.

---

## 4. Camera in use

CoreMediaIO: enumerate `kCMIOHardwarePropertyDevices` on `kCMIOObjectSystemObject`, then read `kCMIODevicePropertyDeviceIsRunningSomewhere` per device, **OR'd across all devices** (this machine has a built-in camera *and* an external one).

Verified from an ad-hoc-signed, hardened-runtime app bundle whose own camera authorization status was `notDetermined`: the property flipped `0 → 1 → 0` exactly bracketing another process's capture. **No prompt appeared, no camera light, and no TCC row was written.**

**Hard boundary, non-negotiable:** under App Sandbox the CMIO device list returns **zero devices** unless the camera entitlement is declared. Therefore: **never enable App Sandbox, and never ship to the Mac App Store.**

Note: the first CMIO connection powers the camera image processor for about 4 seconds. A long-lived process pays this once — which is why the polling lives in-process rather than in a helper invoked per check.

**Not verified:** the property *listener* registers cleanly (`OSStatus 0`, zero permissions) but was never observed actually firing, because that needs the webcam on. There are reports of spurious and cross-process-leaked callbacks on Apple Silicon. Correctness is therefore anchored on the 5-minute property re-read — the listener could be entirely broken and the only symptom would be up to 5 minutes of latency on camera-opens-an-interval.

---

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
