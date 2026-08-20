# Work Week Buddy

A macOS menu-bar app that answers one question honestly: **how many hours did I actually work this week?**

No timers to start. No projects to tag. No categories. It watches the same signals Slack watches to decide you're "active" — real keystrokes, clicks, and whether your camera is live — and turns them into work intervals you can look back on.

> **Status: built, not yet running on a real machine.**
>
> Every layer is implemented and tested — 708 tests across 50 files. The app
> builds, launches as a menu-bar app with no Dock icon, creates its database,
> and its own `--doctor` command reports honestly on what is and is not working.
>
> What is left is the part no amount of code can do for you:
>
> | Step | Why only you can do it |
> |---|---|
> | **Run `./spike/run-m0.sh` on the work Mac** | If device management blocks Input Monitoring for self-signed apps, keyboard tracking is impossible on the machine that generates most of the hours. Nothing else should start until this passes. |
> | **Grant Input Monitoring and Accessibility** | A permission prompt needs a human. Note the app already catches the case where macOS reports "granted" while the event mask it actually handed over is empty. |
> | **Create the Cloudflare D1 database and Worker** | One `wrangler login`. Until then the app tracks locally and the doctor reports sync as *not configured* — which is a distinct state from *failing*. |
> | **Run `./scripts/install.sh`** | Builds, signs with a local certificate, installs to `/Applications`, and gates on the self-test. |
>
> Start at [`docs/ROADMAP.md`](docs/ROADMAP.md) and read [`AGENTS.md`](AGENTS.md)
> before changing anything — it lists thirteen mistakes that produce
> plausible-looking wrong data and throw no error.

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

### Turning sync on

The cloud half is optional and the app ships without it. Until you deploy the Worker there is no URL and no token, and that is a **state, not a failure**: tracking runs at full speed, the dashboard reads the same local database it always reads, the weekly local export still runs, and `--doctor` reports `not configured` rather than an error.

Two settings turn it on:

| | Where it is stored | Why |
|---|---|---|
| Worker base URL | `settings.json` under Application Support | A URL is not a credential |
| Per-machine bearer token | Electron `safeStorage`, backed by the macOS Keychain (`sync-token.bin`) | It is |

Both are written through one IPC call (`wwb:sync:setConfig`), applied to the running app without a relaunch, and the token is never read back out — the renderer only ever learns whether one exists. Deleting `sync-token.bin` returns the app to the unconfigured state; nothing else changes.

Once configured, `flush()` runs on interval close, on wake and at launch; `pull()` runs after every successful flush; and once a week the app exports itself to disk, compares its fingerprint against the cloud's, and checks the 72-hour silence alarm.

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

```bash
./scripts/make-signing-cert.sh   # once, ever. Then set it to Always Trust in Keychain Access.
./scripts/install.sh             # npm ci → build → sign → /Applications → self-test → doctor → LaunchAgent
```

`install.sh` does the `npm ci` and the build itself, and is safe to re-run — that is the upgrade path too. It always installs to exactly `/Applications/Work Week Buddy.app`, because a permission grant is bound to the app's path as well as its signature.

On the **second** Mac, import the same `wwb.p12` that the first one produced (it lands in `~/.wwb-signing/`) instead of running `make-signing-cert.sh` again. Two separately generated certificates have different designated requirements, and grants do not transfer between them.

Two things are deliberately not automated: setting the certificate to *Always Trust*, and answering the two permission prompts on first launch. Both need a human.

Afterwards, and any time something looks wrong:

```bash
npm run doctor              # one line per invariant; non-zero exit if any is red
npm run launch-agent status # is launch-at-login actually loaded?
```

## Before anything is built

Run the M0 spike on the machine you intend to track:

```bash
./spike/run-m0.sh --checks-only   # safe, no prompts
./spike/run-m0.sh                 # the real test
```

If device management blocks Input Monitoring for self-signed apps, keyboard tracking is impossible on that Mac and the product changes shape. Nothing in this spec can determine that — only running it can. See [`spike/README.md`](spike/README.md).

## Documentation

| Document | What's in it |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | The product: features, rules, acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, data flow, the countdown, sync, build and signing |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Schema, sync protocol, every metric as SQL |
| [`docs/MACOS.md`](docs/MACOS.md) | The native layer, and the measured evidence behind each choice |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | What was chosen, what was rejected, and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | M0–M7 with acceptance gates |
| [`docs/TASKS.md`](docs/TASKS.md) | The same work as agent-sized tasks, with dependencies |
| [`docs/NON_GOALS.md`](docs/NON_GOALS.md) | What not to add |
| [`AGENTS.md`](AGENTS.md) | Guardrails. Read before writing code. |

## A note on this repo being public

Only code and documentation live here. Your actual hours live in the database. The database token is stored via Electron's `safeStorage`, backed by the macOS Keychain — never in a plist, never in a dotfile, never committed. CI fails if a credential-shaped string appears in a tracked file.
