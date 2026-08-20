# Work Week Buddy

A macOS menu-bar app that answers one question honestly: **how many hours did I actually work this week?**

No timers to start. No projects to tag. No categories. It watches the same signals Slack watches to decide you're "active" — real keystrokes, clicks, and whether your camera is live — and turns them into work intervals you can look back on.

> **Status: not built yet.** This repo currently contains the specification only. It is written to be implemented by coding agents; start at [`docs/ROADMAP.md`](docs/ROADMAP.md) and read [`AGENTS.md`](AGENTS.md) first.

## How it decides you're working

Two signals, one rule.

- **Real input** — keyboard or mouse — or **a live camera** keeps the current interval alive. A camera in use means you're in a meeting, and a meeting is always work, even when nobody touches the mouse for 50 minutes.
- **A live microphone counts too, but only while a meeting app is running.** That covers audio-only and camera-off calls without letting every dictation session look like work.
- macOS **pushes** each event to the app. There is no polling for input.
- Every signal pushes a **15-minute countdown** back out to 15:00.
- When the countdown finally fires, the interval closes — **at the timestamp of your last real signal, never at the moment the countdown fired.** A 15-minute timeout must never add 15 phantom minutes to a day.

Because each event carries a hardware timestamp, interval ends land on the actual keystroke, sub-millisecond.

## The jiggler problem

The app ships an optional mouse jiggler (off by default). A jiggler that fools Slack would also fool the tracker and report 24-hour workdays — silently, and plausibly.

The app makes the jiggle, so the app marks it: our events are stamped before they are posted, and the stamp is read back off the event tap. Real input arrives with `pid=0, userData=0`; ours arrives with our pid and our magic number. Two independent discriminators, measured clean across 422 events on macOS 26.5.1.

The jiggle is a **null event with no coordinates**, so it resets the system idle clock without being able to move the cursor at all.

## Where the data lives

One **Cloudflare D1** database that both Macs write to, through a small insert-only Worker. Each Mac also keeps a **full local SQLite copy** — that is what the dashboard reads, so it paints instantly, works on a plane, and works while the VPN is down.

Rows are append-only, stamped with the machine that made them, and keyed by a UUID minted before the first upload attempt. Two machines physically cannot write the same row, so there is no merge logic, no conflict UI, and no "which version wins" anywhere in the codebase.

## What it costs

Nothing. No server to run, no Apple Developer account, no paid tier anywhere. Roughly 10 rows a day against a 100,000/day free cap.

## What it asks permission for

| Capability | Permission | If denied |
|---|---|---|
| Keyboard events | Input Monitoring | Keyboard goes untracked *silently* — so the app asserts it actually got the grant and shows a red banner if not. Mouse and camera keep working. |
| The mouse jiggler | Accessibility | Jiggler disabled with a tooltip. Tracking unaffected. |
| Mouse events | none | — |
| Camera-in-use detection | none | Verified: no prompt, no camera light, nothing written to the permission log. |
| Keep awake | none | — |

## Install

Built locally on each Mac, so Gatekeeper never engages and no notarization is needed. A self-signed certificate gives a stable code identity, which is what keeps your permission grants alive across rebuilds.

```
npm ci
npm run build
./scripts/install.sh        # signs, copies to /Applications, runs the self-test, installs the LaunchAgent
```

## Documentation

| Document | What's in it |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | The product: features, rules, acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, data flow, the countdown, sync, build and signing |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Schema, sync protocol, every metric as SQL |
| [`docs/MACOS.md`](docs/MACOS.md) | The native layer, and the measured evidence behind each choice |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | What was chosen, what was rejected, and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | M0–M7 with acceptance gates |
| [`docs/NON_GOALS.md`](docs/NON_GOALS.md) | What not to add |
| [`AGENTS.md`](AGENTS.md) | Guardrails. Read before writing code. |

## A note on this repo being public

Only code and documentation live here. Your actual hours live in the database. The database token is stored via Electron's `safeStorage`, backed by the macOS Keychain — never in a plist, never in a dotfile, never committed. CI fails if a credential-shaped string appears in a tracked file.
