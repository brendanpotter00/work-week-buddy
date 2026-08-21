# Implementation tasks

`docs/ROADMAP.md` has the milestones and their gates. This is the same work broken into units an agent can pick up, with dependencies.

**Rule: a task is not done until its gate passes.** The gates are in the roadmap and they are scripts, not judgment calls.

| # | Task | Depends on | Deliverable |
|---|---|---|---|
| **0.1** | Run the M0 spike on the work Mac | — | A GO verdict from `./spike/run-m0.sh`. **Nothing below starts until this passes.** |
| **0.2** | Cloudflare setup: `wrangler login`, create the D1 database, deploy the Worker skeleton, set one secret per machine | 0.1 | `curl <worker>/health` returns 200 from both Macs |
| **1.1** | Scaffold: electron-vite, TypeScript, tray-only app with no dock icon, `.nvmrc`, ESLint with the banned-API rules from `AGENTS.md` | 0.1 | App launches as a menu-bar icon; every lint rule proven to fire against a deliberate violation |
| **1.2** | `native.ts` — all koffi declarations in one file, plus a boot test exercising each once | 1.1 | Boot test green |
| **1.3** | Event tap: create, register in both run-loop modes, assert the granted mask, handle and recover from `tapDisabledByTimeout` | 1.2 | M1 gates (a)–(e) |
| **1.4** | Jiggler: null event, stamped and filtered; the self-test that proves our own events are identified as ours | 1.2 | M1 gate (c); cursor provably never moves |
| **1.5** | Camera + microphone in-use detection, plus the 60-second floor under the mic (the meeting-app conjunction this once carried was removed — PRD §3.5) | 1.2 | M1 gate (g); mic needs no permission, or it is reported loudly |
| **1.6** | Keep-awake via power assertion | 1.2 | Visible in `pmset -g assertions`, gone after release |
| **2.1** | The interval reducer — pure, no Electron imports, timestamps as data | 1.1 | M2 gates (a)–(f) |
| **2.2** | The lazy countdown scheduler, main-process only, absolute deadline | 2.1 | Fires correctly when stepped hours into the past |
| **2.3** | Signal wiring: tap + camera + mic → reducer → effects | 1.3, 1.5, 2.1 | Real signals drive real state |
| **3.1** | Local store: `node:sqlite`, schema, the open-interval journal | 2.1 | M3 gate (a) — `kill -9` recovers with ≤30s lost |
| **3.2** | Crash recovery and single-instance enforcement | 3.1 | M3 gates (b), (c) |
| **4.1** | The Worker: insert-only routes, per-machine tokens, fingerprint | 0.2 | Rejects the wrong token; `DELETE` impossible by route surface |
| **4.2** | Flush: outbox drain, presence-keyed marking, single-flight backoff | 3.1, 4.1 | M4 gates (a), (b) |
| **4.3** | Pull: watermark with the 200-row overlap, `INSERT OR IGNORE` | 4.2 | M4 gate (c) — skips no rows |
| **4.4** | Backups: weekly self-export, fingerprint reconciliation, 72h silence alarm | 4.3 | M7 gates (c), (e) |
| **5.1** | Tray: live "hours this week" driven from main, updated once a minute | 2.2, 3.1 | Keeps updating with the window closed |
| **5.2** | Toggles: Jiggler, Keep awake, Pause tracking — including the interval-boundary behaviour on jiggler toggle | 1.4, 1.6, 2.1 | M5 gates (a), (b) |
| **5.3** | Permission onboarding + the degraded-state banner | 1.3 | M5 gate (c) — revoking a permission is loud, not a silent zero |
| **6.1** | Port `design/App.reference.tsx`; the three required fixes in `design/README.md` | 3.1 | Matches the mockups, screenshotted in the built app |
| **6.2** | The six queries from `docs/DATA_MODEL.md` behind IPC | 3.1 | Real numbers, `v_countable` carries every policy knob |
| **7.1** | Self-signed certificate, `install.sh`, LaunchAgent | 1.1 | M7 gates (a), (b) — rebuild does not require re-granting |
| **7.2** | Second-Mac bring-up | 7.1, 4.3 | Mac B shows Mac A's history within 5 minutes |
| **7.3** | Observe a real lid-close sleep cycle | 7.2 | M7 gate (g). **No automation covers this.** |

## Parallelism

After 1.1, three tracks run independently:

- **native** — 1.2 → 1.3 / 1.4 / 1.5 / 1.6
- **logic** — 2.1 → 2.2, then 3.1 → 3.2
- **cloud** — 0.2 → 4.1

They converge at 2.3, then 4.2. UI (6.x) only needs 3.1, so it can start early against seeded data.

## Where agents get things wrong

Read `AGENTS.md` first. It lists 13 mistakes that produce plausible-looking wrong data and throw nothing — most of them in tasks 1.3, 1.4 and 4.2.
