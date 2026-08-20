# Decisions

What was chosen, what was rejected, and why. Two rounds of research fed this; where a decision overturned an earlier one, both are recorded.

## The big ones

### Electron + TypeScript, not Tauri + Rust
**Owner constraint:** *"I don't want to use Rust because I don't know how. I want TypeScript or Python, something I've worked in before."*

Tauri's core is Rust, so Tauri went with it. Verified that TypeScript reaches every needed macOS API through koffi — no Rust, no C++, no compiler, no second process.

**Cost, stated honestly:** ~209 MB resident versus ~40–60 MB for a native shell. CPU and battery are 0.0%. The owner accepted this explicitly.

**Reversibility:** the interval logic is a pure reducer with no Electron imports (enforced by lint), so the shell is swappable. `src/core/` and the signal-source interface are arranged so the menu bar could move to a native helper later at the cost of one file.

### Push, not polling
**Owner constraint:** *"It shouldn't really be polling. It should have a countdown timer of 15 minutes and every time you get an input it should reset."*

Correct, and it turned out the polled API was also the broken one — it is polluted by our own jiggler at every tap location. Removing the tick and removing the pollution were the same change.

The event-driven design is *more* accurate: interval ends land on the actual keystroke rather than within 5 seconds of it.

**One tick survives**, and it is documented rather than hidden: a 5-minute read-only watchdog. Two of the three tap-death modes are not self-reporting, and an active probe is impossible because even a null canary event resets the idle clock. Owner chose to keep it always-on.

### One hosted database, not a git archive
**Owner constraint:** *"Using GitHub as cloud storage seems a little manual"* and *"I want it all to sync back into one database."*

Revision 1 proposed local SQLite plus an append-only NDJSON archive in a private git repo. Rejected. The objection was about *who does the work*, so the replacement had to be one database with nothing manual in the loop.

### Cloudflare D1, not Supabase or Neon
Chosen for one boring property: **it never goes to sleep.**

| Rejected | Why |
|---|---|
| **Supabase** | Pauses free projects after 7 days of low activity, and recovery is a human clicking Resume. A *work* tracker's quiet weeks are vacations, making that an annual chore at the worst moment. Revision 1 rejected it for lacking automated backups; that was the weaker argument. |
| **Neon** | A documented compute throttle can suspend the project mid-month. Recommended mid-session, then withdrawn on verification. |
| **Turso** | Free databases archive after 10 days idle; local-first sync sits on a beta engine; a documented 2023 free-tier data-loss incident. |
| **Firebase** | Enforced exactly this class of free-tier withdrawal in February 2026. |

D1 also happens to be SQLite, so cloud and local mirror share a dialect and the same queries run against both.

**Nobody guarantees ten years at $0**, and the architecture — not a vendor promise — delivers the durability. See the four backup layers in `docs/DATA_MODEL.md`.

### A Worker, not raw REST
Not for scale. It is the only way to give the work Mac a credential that can insert and read but **cannot** drop a table. It also sidesteps D1's 100-bound-parameter cap, which would otherwise limit a raw REST request to 5 rows.

### The jiggler posts a null event
An event type carrying no coordinates. Measured: it resets the system idle clock exactly like a mouse move, but **cannot move the cursor**. Strictly better than every mouse jiggler — no drift, no accidental drags, nothing fighting the pointer.

### Our own jiggle is identified by a stamp, not a heuristic
**Owner insight:** *"The jiggler is built into this application. So when we talk about this application, it knows."*

Correct, and Revision 1's counter-correlation workaround was over-engineering. It is one field read now, with a second independent field as corroboration. Measured clean across 422 events.

### Self-signed certificate, no Apple Developer account
A locally built app carries no quarantine attribute, so Gatekeeper never engages. The one real cost of not paying is that ad-hoc signatures change identity on every build, resetting TCC grants — fixed by one self-signed certificate with a stable designated requirement, shared by both Macs.

**Do not** use the `Apple Development: …` certificate already in the keychain. It is an employer team identity and it expires.

## Owner decisions

| # | Decision | Chosen |
|---|---|---|
| Repo name | `work-week-buddy` | ✔ |
| Visibility | public | ✔ |
| Mouse jiggler | ship it, off by default | ✔ |
| Two machines active at once | union — counts once | ✔ |
| Jiggler semantics | **(a) jiggler ON = off the clock** | ✔ — chosen over the recommendation; see PRD §6 for the exact implementation and the one accepted consequence |
| Watchdog tick | always on, every 5 minutes | ✔ |
| Menu-bar title | hours this week | ✔ |
| ~209 MB resident | accepted | ✔ |

## Rejected implementation shortcuts

| Shortcut | Why not |
|---|---|
| `uiohook-napi` for global input | Its payload has no source pid or userData, so it structurally cannot tell our jiggle from a human. Fatal. |
| `powerMonitor.getSystemIdleTime()` | Wraps the jiggle-polluted seconds-since-input API. ESLint-banned. |
| A Swift sidecar | Its TCC grant would attach to the sidecar binary, splitting the permission story across two identities. Kept in the repo as an unused escape hatch. |
| `better-sqlite3` | `node:sqlite` ships in Electron 43. Deletes a native dep and `electron-rebuild`. |
| NSWorkspace sleep/wake notifications as the authority | The wall-clock comparison is strictly better and also catches App Nap, crashes and hard power-off, which notifications miss. |
| A per-tick sample table | Blows every size budget for no benefit. Intervals plus the open-interval journal are enough. |
| App Sandbox / Mac App Store | The camera device list returns zero devices under sandbox. |
