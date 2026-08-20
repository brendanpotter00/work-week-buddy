# Guardrails

Read this before writing code. Everything here is a mistake that was actually made, or one that produces **plausible-looking wrong data with no error**.

## The rule that outranks everything

> **An interval ends at the timestamp of the last real signal. Never at the moment the countdown fired. Never `now()`.**

If a change makes `ended_at_ms` closer to `now()`, it is a bug. There is a unit test and a property test guarding this. Do not "fix" them.

## Silent-failure list

These throw nothing and look fine. Each has a required mitigation.

| # | Mistake | What you'd see | Mitigation |
|---|---|---|---|
| 1 | Event tap source registered only in `kCFRunLoopCommonModes` | Zero events, no error, tap reports enabled | Register in **both** Default and Common modes; assert events arrive |
| 2 | Keyboard permission not actually granted | Tap returns non-NULL with keyboard bits stripped; hours come out slightly low forever | Assert the granted mask via `CGGetEventTapList` at boot |
| 3 | `kCGEventFlagsChanged` (type 12) missing from the mask | Modifier-only presses invisible | Startup assertion on the mask |
| 4 | Comparing `kCGEventSourceUserData` against a BigInt literal | Always false → our own jiggle counts as human input → **24-hour workdays** | Read as a number; `typeof === 'number'` assertion; boot self-test |
| 5 | Using `kCGEventSourceStateID` as the discriminator | Reads back `1` for both real and synthetic | Use `userData` **and** pid |
| 6 | Jiggling to a different tap location than the tap listens at | Our jiggle is invisible to our own filter | Same location, asserted |
| 7 | Any use of `CGEventSourceSecondsSinceLastEventType` / `ioreg HIDIdleTime` / `powerMonitor.getSystemIdleTime()` | Polluted by our own jiggler | ESLint `no-restricted-properties`, message: *"Polluted by CGEventPost. Use lastRealSignalMs."* |
| 8 | Marking a row synced before the HTTP 200 returns | Silent data loss on a lost response | Mark on **presence** in the response, never on the insert result |
| 9 | Strict `seq > watermark` on pull | Permanently skips rows when identity values become visible out of order | Pull from `watermark - 200`; there is a test |
| 10 | Keeping the 15-minute deadline in the renderer | A hidden renderer's timers collapse — measured 153 of 400 ticks with a clean 60-second gap | Deadline lives in **main**, as an absolute epoch-ms value, never a duration |
| 11 | `CGEventSourceSecondsSinceLastEventType(kCGEventSourceStatePrivate, …)` | **Blocks forever** | Never call it |
| 12 | Enabling App Sandbox | CMIO device list returns zero devices; camera detection dies silently | Never sandbox |
| 13 | Reading a field before handling the tap-disabled callback | Garbage read on type `0xFFFFFFFE` | Handle the disable notice first, then re-enable |

## Structural rules

- **`src/core/` imports nothing from `electron`.** Enforced by `no-restricted-imports`. The interval machine is a pure reducer over timestamps-as-data, which is why a 15-minute test is arithmetic and runs in microseconds.
- **All koffi declarations live in one `native.ts`.** Prototypes are string-typed, so a wrong signature is a segfault rather than a compile error. A boot test exercises every declaration once. Do not scatter FFI through the codebase.
- **The local mirror is the outbox.** There is no separate queue table. Do not add one.
- **Rows are never deleted or updated.** Exclusion is a query-time filter. The Worker has no `DELETE` or `UPDATE` route, and that route surface is the enforcement — not a comment.
- **Policy knobs live in `v_countable` and nowhere else.** If a product decision starts leaking into application code, put it back in the view.
- **Toggling the jiggler closes the current interval and opens a new one.** Every stored interval must be homogeneous — `jiggler_s` is either `0` or equal to `duration_s`, never in between. Partial coverage breaks the cross-machine union merge.

## Environment

- Node **22.14.0** via `.nvmrc` for tooling. The machine default 22.1.0 is known-bad here. Electron embeds its own Node; koffi is Node-API so ABI does not matter.
- Vite pinned to **7.3.6**. electron-vite 5's peer range stops at 7. This is mandatory, not conservatism.
- Install to `/Applications/Work Week Buddy.app`, always. Permission grants bind to bundle id + designated requirement + path.
- **Dev and prod are different apps to macOS.** In dev the TCC subject is Electron's own bundle. Expect "works in dev, silently dead when packaged" exactly once — then remember it.

## Secrets

The repo is **public**. The database token goes through Electron `safeStorage`, backed by the Keychain. Never a plist, never a dotfile, never the asar, never a test fixture, never a commit. CI fails if a credential-shaped string appears in a tracked file.

## When you are unsure

`docs/MACOS.md` records what was measured and, just as importantly, **what was not**. Section 8 lists the things nobody has verified yet. If your task touches one of them, verify it rather than assuming — the last two rounds of this project each overturned an assumption that looked safe.
