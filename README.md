# Work Week Buddy

A macOS menu-bar app that answers one question honestly: **how many hours did I actually work this week?**

No timers to start. No projects to tag. No categories. It watches the same signals Slack watches to decide you're "active" — real keystrokes, clicks, and whether your camera is live — and turns them into work intervals you can look back on.

> **Status: built, not yet running on a real machine.**
>
> Every layer is implemented and tested — 1016 tests across 67 files. The app
> builds, launches as a menu-bar app with no Dock icon, creates its database,
> and its own `--doctor` command reports honestly on what is and is not working.
>
> [**`docs/BRINGUP.md`**](docs/BRINGUP.md) is the ordered checklist from a fresh
> clone to two Macs syncing. What is left in it is the part no amount of code can
> do for you:
>
> | Step | Why only you can do it |
> |---|---|
> | **Run `./spike/run-m0.sh` on the work Mac** | If device management blocks Input Monitoring for self-signed apps, keyboard tracking is impossible on the machine that generates most of the hours. Nothing else should start until this passes. |
> | **Grant Input Monitoring and Accessibility** | A permission prompt needs a human. Note the app already catches the case where macOS reports "granted" while the event mask it actually handed over is empty. |
> | **Make a Cloudflare API token** | Choosing which account gets billed is a decision, not a step. Everything after it is **Settings → Cloud sync → *Set up cloud sync…*** — no terminal. `docs/CLOUDFLARE.md` lists the three permissions the token needs. |
>
> Once the Worker is deployed, the URL and the token go into **Settings** —
> reachable from the menu-bar icon, from the gear on the dashboard, or with ⌘,.
> There is a *Test connection* button that tries the pair before saving, so a
> wrong URL or a swapped token is answered immediately rather than silently.
> Until you set it up the app tracks locally and the doctor reports sync as
> *not configured* — a distinct state from *failing*, and the rows are safe in
> the local mirror meanwhile.
>
> Start at [`docs/ROADMAP.md`](docs/ROADMAP.md) and read [`AGENTS.md`](AGENTS.md)
> before changing anything — it lists thirteen mistakes that produce
> plausible-looking wrong data and throw no error.

## How it decides you're working

Two signals, one rule.

- **Real input** — keyboard or mouse — or **a live camera** keeps the current interval alive. A camera in use means you're in a meeting, and a meeting is always work, even when nobody touches the mouse for 50 minutes.
- **A live microphone counts too, whatever is holding it.** A call, dictation, a recording — if the mic is open you are at the machine. A capture shorter than 60 seconds is ignored, so asking Siri the time is not a workday.
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

Both are entered in **Settings** — the menu-bar icon → *Settings…*, the gear on the dashboard, or ⌘,. The pane shows which of the three states sync is in (*not set up*, *syncing*, *not syncing*), the pending-row count, the last upload and download, and the row-count check; and *Test connection* calls the Worker's unauthenticated `/health` followed by one authenticated read, so "wrong URL" and "wrong token" come back as different answers **before** anything is stored.

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

[**`docs/BRINGUP.md`**](docs/BRINGUP.md) is the numbered, copy-pasteable version
of this, from a fresh clone to two Macs syncing, with what you should see at each
step and what it means if you do not. This section is the shape of it.

Built locally on each Mac, so Gatekeeper never engages and no notarization is needed. A self-signed certificate gives a stable code identity, which is what keeps your permission grants alive across rebuilds.

```bash
nvm install && nvm use           # .nvmrc → 22.14.0; 22.1.0 is known-bad here
./scripts/make-signing-cert.sh   # once, ever — no GUI, no trust step, no password
./scripts/install.sh             # npm ci → build → sign → /Applications → self-test → doctor → LaunchAgent
```

`install.sh` does the `npm ci` and the build itself, and is safe to re-run — that is the upgrade path too. It always installs to exactly `/Applications/Work Week Buddy.app`, because a permission grant is bound to the app's path as well as its signature. The self-test is a **hard gate** over two promises: that the app tells its own synthetic jiggle from human input (fail that and the week inflates with fake time and looks fine), and that the jiggle moves nothing on screen. Either failure stops the install before launch-at-login is wired up, and the transcript names which one.

It runs the self-test one line after an install you just typed, so it runs **while you are using the Mac** — and it is built to survive that rather than to ask you to sit still. A check that cannot get a verdict with a hand on the trackpad reports `COULD NOT BE MEASURED` (`?` rather than `ok`) and lets the install continue with a warning. That third state exists because the alternative was measured: the cursor check used to fail on any mouse movement at all, it failed two real installs, and the only way to get the tracker running again was to bypass the gate by hand. **A safety gate that fails during normal use trains you to bypass it**, which is worse than not having one.

**There is no "Always Trust" step.** There used to be, and it was wrong. Keychain Access will show **WWB Local Signing** as untrusted forever, and that is fine: trust governs *chain validation* — Gatekeeper, `spctl`, `security find-identity -v` — and none of those are in this picture. `codesign` signs with an untrusted leaf without complaint, and the designated requirement it produces pins the certificate by hash without naming an anchor, so no chain is ever built and TCC never consults trust. Verify with `./scripts/make-signing-cert.sh --show`, which signs a throwaway binary and prints the requirement it got back.

**Back up `~/.wwb-signing/wwb.p12`.** On the **second** Mac, put that same file in place and run `make-signing-cert.sh` again — it re-imports rather than minting a second leaf. Two separately generated certificates have different designated requirements, and grants do not transfer between them. The archive's passphrase is `work-week-buddy` and is deliberately not a secret; the script explains why. Losing the file means re-granting Input Monitoring and Accessibility on both machines.

Two things are deliberately not automated: `wrangler login`, and answering the two permission prompts on first launch. Each is a person deciding something. Note that a prompt is **one shot per permission** — if you dismiss or deny one, macOS never asks again, and the app will say so and send you to System Settings rather than drawing a button that cannot work.

Afterwards, and any time something looks wrong:

```bash
npm run doctor              # one line per invariant; non-zero exit if any is red
npm run launch-agent status # is launch-at-login actually loaded?
```

## Looking at it

```bash
npm run smoke                          # launches the app, opens both windows, measures them
WWB_SMOKE_DIR=/tmp/wwb npm run smoke   # …and leaves screenshots + a JSON report there
```

The unit tests mount components in a jsdom that has no window, no size and no
URL, so they cannot see a window that is the wrong size or showing the wrong
view. This does: it opens the dashboard and the onboarding windows for real and
fails if either renders the wrong view, if either one's content is wider than
its viewport, or if the fixed 560 × 640 onboarding window cannot hold its own
contents. It runs in CI's macOS job. `docs/IMPL_UI.md` §7.3 has the full list.

## The cloud half

**Menu-bar icon → *Set up cloud sync…***, and paste one Cloudflare API token.
That is the whole of it: no terminal, no `wrangler login`, no Node toolchain on
the Mac being set up. It is on the tray whenever sync is unconfigured, and in
Settings → Cloud sync either way. `docs/CLOUDFLARE.md` has the permissions the
token needs — two required, two you can skip — and how to make one.

Setup creates or **adopts** the D1 database, applies `worker/schema.sql`,
**enrols this Mac**, deploys the Worker, turns on its addresses, proves they
answer, and stores this Mac's token in the Keychain. Pasting the token starts
nothing — a read-only probe runs first, and the next screen says what is already
on the account, including which Macs are already enrolled.

**Addresses, plural.** The `workers.dev` one is always on. You can also put the
Worker on a domain you already have on the same Cloudflare account, and then
both are live: each Mac uses whichever it can reach, and the app reports what
each one did. Some work networks block `*.workers.dev` because everybody's
Workers share it. Nothing is traded away for the second address — both reach the
same script and the same database — and it needs no extra permission.

**Each Mac enrols itself, and only itself.** It mints its own token, keeps the
plaintext in its own Keychain, and sends Cloudflare only the SHA-256 — recorded
next to its own `IOPlatformUUID` in a `machine_token` table. So there is no slot
to pick, no token to carry to the second Mac, and nothing to swap. Adding a
machine is installing the app there and running the same setup.

That matters because the old failure was silent. The Worker stamps `machine_id`
from the credential and never from the request body — which is what stops a
stolen token forging another machine's rows — and a mismatched id used to fail
*invisibly*: both Macs synced, both mirrors converged, every total was right, and
the per-machine breakdown credited the wrong laptop. Forever. A machine can now
only ever enrol its own id, and only from the machine itself, so that outcome is
not merely detected — it is unconstructible.

Safe to run again: the database is adopted rather than recreated, and only *this*
Mac's older tokens are retired, after the new one is stored. Revoking another Mac
is one click on the review screen and takes effect on its next request.

The API token is used for that one run and discarded — never written to a file,
never logged, never returned over IPC. You can delete it in the dashboard as soon
as setup finishes.

For a terminal escape hatch, see `docs/CLOUDFLARE.md` → *If the app cannot do
it*. There is no longer a `bringup:cloud` script: it was where the two-slot model
came from, and keeping it would have meant implementing enrolment twice.

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
| [`docs/BRINGUP.md`](docs/BRINGUP.md) | Fresh clone → two Macs syncing, numbered, with what each step should print |
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
