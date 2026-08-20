# The 24 tasks, expanded

`docs/TASKS.md` names the work. `docs/ROADMAP.md` names the gates. **This file says what to type.**

Every task below is a self-contained brief: exact file paths, the interfaces to implement, one command that proves it, the tests by name, and which of `AGENTS.md`'s 13 silent failures can bite *this* task. An agent that reads its own brief plus the docs it references should never need to ask a question.

**Read first, always:** `AGENTS.md`, then `docs/NON_GOALS.md`. Then your task's brief.

---

## 0. How to use this document

| If you are… | Read |
|---|---|
| An agent assigned one task | §2 (conventions), §3 (interface index), your task's brief, then the IMPL doc your brief names |
| The orchestrator | §5 (execution order) and §6 (project done) |
| A reviewer | §6, then the Traps line of every touched task |

**A task is not done until its gate passes.** Not "the code looks right", not "the tests pass" — the gate command in the brief runs and prints what the brief says it prints.

---

## 1. Vocabulary, fixed

| Term | Means exactly |
|---|---|
| **real signal** | A keyboard or mouse event that passed the ours-vs-theirs filter, or a camera/mic-meeting level edge. Never a jiggle, never a toggle, never UI interaction. |
| **last real signal** | `max(lastRealInputMs, lastLevelEvidenceMs)` — see `endTimestamp()` in §T2.1. This is what an interval ends at. |
| **level** | Camera-in-use, mic-in-use. A state, not an event. Converted to edges by the source adapters. |
| **edge** | A transition of a level, synthesized into a `Signal` with a timestamp. |
| **deadline** | An **absolute epoch-ms** number living in the main process. Never a duration. Never in the renderer. |
| **homogeneous interval** | `jiggler_s` is `0` or exactly `duration_s`. Guaranteed by construction, not by accumulation. |
| **gate** | A script whose stdout contains `GATE <id> PASS` for every check and which exits `0`. |

---

## 2. Conventions that bind every task

These remove the choices that would otherwise diverge between agents. They are not suggestions.

### 2.1 Time

- **All timestamps in `src/core/` and in the database are epoch milliseconds, UTC, `number`.** Suffix every such field `Ms`.
- Seconds only appear in stored columns that `docs/DATA_MODEL.md` declares as seconds; suffix those `S`.
- `src/core/` **never calls `Date.now()`.** Time enters the reducer as `input.atMs`. This is what makes a 15-minute test arithmetic.
- Mach → epoch conversion lives in exactly one place: `src/main/native/clock.ts`. See §T1.3.

### 2.2 Error handling — two categories, no third

```ts
// src/main/degrade.ts
export type DegradeCode =
  | 'keyboard_mask_missing'   // trap 2/3 — tap alive, keyboard bits stripped
  | 'tap_lost'                // trap 1/13 — tap disabled, recreated
  | 'accessibility_denied'    // CGEventPost would no-op
  | 'mic_prompted'            // M1 gate (g) failed: mic needed a permission
  | 'jiggle_unfiltered'       // trap 4/5/6 — self-test round-trip failed
  | 'fingerprint_mismatch'
  | 'sync_silent_72h'
  | 'db_unavailable';

export interface Degradation { code: DegradeCode; sinceMs: number; detail: Record<string, unknown> }

export function degrade(code: DegradeCode, detail: Record<string, unknown>): void;
export function recover(code: DegradeCode): void;
export function active(): Degradation[];
export function onChange(fn: (d: Degradation[]) => void): () => void;
```

- **Programmer error → `throw`.** A wrong koffi signature, a non-monotonic input, a missing column. Crash loudly in dev; the crash journal in §T3.2 recovers the interval.
- **Environment failure the user must see → `degrade(code, detail)`.** It persists to `sync_state` under key `degradations`, turns the tray icon red, and shows the renderer banner (§T5.3).
- **There is no third category.** No `catch { console.warn() }` followed by continuing. A swallowed error in this app is a wrong number, and a wrong number is the only failure that matters.

### 2.3 Module boundaries

| Directory | May import | May **not** import |
|---|---|---|
| `src/core/` | nothing but other `src/core/` files and `node:` type-only | `electron`, `koffi`, `node:sqlite`, anything with I/O |
| `src/main/native/` | `koffi`, `src/core/` types | `electron` UI modules, `src/renderer/` |
| `src/main/**` | everything main-side | `src/renderer/` |
| `src/renderer/` | React + `window.wwb` | `electron`, `node:*`, `src/main/` |
| `src/shared/` | nothing (types only) | everything |

Enforced by `eslint no-restricted-imports` in §T1.1, with a fixture proving each rule fires.

### 2.4 Naming

- Files: `kebab-case.ts`. Types: `PascalCase`. Functions: `camelCase`. Constants: `SCREAMING_SNAKE`.
- No default exports except React components.
- No `any`. `unknown` + a narrowing function. `koffi` returns are typed at the boundary in `native.ts` and never leak untyped.
- Discriminated unions use the key `kind`, always.

### 2.5 Testing

- `vitest` 4.1.11. `test/core/**` runs in the `node` environment with **zero** mocks — the reducer is pure.
- Fakes live in `test/fakes/`, never inline: `fake-clock.ts`, `fake-signal-source.ts`, `fake-sync-client.ts`, `seed-db.ts`.
- Every test name is a **sentence stating the invariant**, not `works correctly`.
- Property tests use `fast-check` (dev dependency, allowed — no native code).

### 2.6 Gate script protocol

Every gate script prints one line per check and nothing else on stdout:

```
GATE m1.a PASS  granted mask 0x...F0C includes keyDown|keyUp|flagsChanged
GATE m1.b FAIL  no real event within 60000ms
```

Exit code = number of `FAIL` lines. `scripts/gate/lib.sh` provides `gate_pass <id> <msg>` / `gate_fail <id> <msg>`.

### 2.7 The app's own CLI

Defined in §T1.1, used by half the gates:

| Flag | Does |
|---|---|
| `--selftest` | Boot assertions + tagged-jiggle round trip. JSON to stdout, exit 0/1. **Hard gate in `install.sh`.** |
| `--doctor` | Permissions, tap mask, db, sync watermark, degradations. Human-readable, exit 0 if all green. |
| `--gate <id>` | Runs one on-device probe (e.g. `--gate m1.d`). JSON, exit 0/1. |
| `--headless` | No tray, no window. Combined with the above. |

---

## 3. Interface index

Symbols are **owned** by the doc listed. This file reproduces signatures for locality; if the two ever disagree, the owning doc wins and this file gets fixed.

| Symbol | File | Owned by |
|---|---|---|
| `reduce`, `State`, `Signal`, `Command`, `Effect`, `Config`, `ClosedInterval` | `src/core/reduce.ts`, `src/core/types.ts` | `IMPL_CORE.md` |
| `uuidv7`, `clampMonotonic`, `localDateOf` | `src/core/uuid.ts`, `src/core/time.ts` | `IMPL_CORE.md` |
| `DeadlineScheduler` | `src/main/scheduler.ts` | `IMPL_CORE.md` |
| `native` (every koffi declaration) | `src/main/native/native.ts` | `IMPL_NATIVE.md` |
| `EventTap`, `Jiggler`, `CameraWatch`, `MicWatch`, `KeepAwake`, `Permissions`, `machineId()` | `src/main/native/*.ts` | `IMPL_NATIVE.md` |
| `Watchdog` | `src/main/watchdog.ts` | `IMPL_NATIVE.md` |
| `openDb`, `migrate`, `insertClosed`, `pending`, `markSynced`, `upsertFromCloud`, journal fns | `src/main/store/*.ts` | `IMPL_STORE_SYNC.md` |
| `SyncClient`, `flush`, `pull`, `fingerprintLocal`, `weeklyBackup` | `src/main/sync/*.ts` | `IMPL_STORE_SYNC.md` |
| `DashboardData` and the six query fns | `src/main/store/queries.ts` | `IMPL_STORE_SYNC.md` |
| `IpcApi`, `WireRow`, `CloudRow`, `ToggleState`, `PermissionState` | `src/shared/*.ts` | `IMPL_LAYOUT.md` |
| Tray, window, renderer components | `src/main/tray.ts`, `src/renderer/**` | `IMPL_UI.md` |
| Repo layout, tsconfigs, build, lint rules | — | `IMPL_LAYOUT.md` |

---

# 4. The 24 briefs

---

## Wave 0 — the go/no-go

### T0.1 · Run the M0 spike on the work Mac

**Depends on:** nothing. **Blocks:** everything.

**Files**
- `spike/run-m0.sh` — exists, do not rewrite
- `spike/RESULT-<hostname>-<YYYY-MM-DD>.txt` — created (the captured transcript)

**What to do**
1. On the **work** Mac: `./spike/run-m0.sh --checks-only` first. Read the output. It prompts for nothing.
2. Then `./spike/run-m0.sh` and click through both System Settings panes when they open.
3. `tee` the whole transcript into `spike/RESULT-<hostname>-<date>.txt` and commit it.
4. Record the verdict in the PR body: **GO**, **NO-GO**, or **INCONCLUSIVE**.

**Definition of done**

```bash
./spike/run-m0.sh 2>&1 | tee "spike/RESULT-$(scutil --get ComputerName)-$(date +%F).txt"
echo "exit=${PIPESTATUS[0]}"
```

Expect `exit=0` and, in section 3, a line confirming the granted tap mask **includes the keyboard bits**. Exit `1` = NO-GO: stop the project and re-scope. Exit `2` = inconclusive: install Xcode CLT (`xcode-select --install`) and re-run — do **not** treat 2 as a pass.

**Tests to write** — none. This is an observation, not code.

**Traps** — #2 in advance: the spike exists precisely because a tap comes back non-NULL with keyboard bits silently stripped. If section 3 prints a mask without `keyDown|keyUp|flagsChanged`, that is the NO-GO, regardless of what System Settings shows as toggled on.

**Size** — small · **requires the work Mac.** Cannot be faked, cannot be done on the personal Mac, and its answer is the premise of every other task.

---

### T0.2 · Cloudflare: D1 database, Worker skeleton, per-machine secrets

**Depends on:** 0.1. **Blocks:** 4.1.

**Files created**
- `worker/wrangler.toml`
- `worker/src/index.ts` — health route only at this stage
- `worker/schema.sql` — the cloud half of `docs/DATA_MODEL.md`, verbatim
- `worker/package.json`, `worker/tsconfig.json`
- `docs/CLOUD_SETUP.md` — the exact commands that were run, with ids redacted

**What to implement**

```toml
# worker/wrangler.toml
name = "wwb-sync"
main = "src/index.ts"
compatibility_date = "2026-08-01"
[[d1_databases]]
binding = "DB"
database_name = "wwb"
database_id = "<from wrangler d1 create>"
```

```ts
// worker/src/index.ts  (skeleton — 4.1 fills in the rest)
export interface Env { DB: D1Database; TOKEN_PERSONAL: string; TOKEN_WORK: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, ms: Date.now() });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

Human steps, in order: `wrangler login` → `wrangler d1 create wwb` → paste the id into `wrangler.toml` → `wrangler d1 execute wwb --remote --file=worker/schema.sql` → `wrangler deploy` → `wrangler secret put TOKEN_PERSONAL` and `wrangler secret put TOKEN_WORK` with two independently generated 32-byte random strings (`openssl rand -base64 32`).

**The secrets are never written to a file in this repo.** They go straight from `openssl` into `wrangler secret put`, and into each Mac's Keychain via §T4.2's `token.ts`.

**Definition of done**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://wwb-sync.<subdomain>.workers.dev/health   # → 200
wrangler d1 execute wwb --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1"
```

Expect `200` **run from both Macs**, and the table list `machine, work_interval` (plus `sqlite_sequence`).

**Tests to write** — none yet; 4.1 brings `worker/test/`.

**Traps** — none of the 13 apply. The one hazard is human: a secret pasted into a shell that has history enabled. Use `wrangler secret put` interactively and let it read stdin.

**Size** — small · **needs a real network on both Macs** (proving the work Mac's proxy allows `workers.dev` is half the point).

---

## Wave 1 — scaffold and the native layer

### T1.1 · Scaffold, lint rules, app CLI

**Depends on:** 0.1. **Blocks:** everything in `src/`.

**Files created**
```
.nvmrc                      22.14.0
package.json
tsconfig.json  tsconfig.node.json  tsconfig.web.json
electron.vite.config.ts
electron-builder.yml
eslint.config.js
vitest.config.ts
scripts/gate/lib.sh
src/main/index.ts
src/main/cli.ts
src/main/degrade.ts
src/preload/index.ts
src/renderer/index.html  src/renderer/main.tsx  src/renderer/App.tsx
src/shared/ipc-contract.ts
src/core/index.ts            (empty barrel; 2.1 fills it)
test/lint-fixtures/*.ts      deliberate violations, one per rule
```

**What to implement**

- Exact versions from `docs/ARCHITECTURE.md` §2. **Vite pinned to `7.3.6`** (`"vite": "7.3.6"`, no caret). electron-vite `5.0.0`. Electron `43.4.1`. koffi `3.1.5`. No `better-sqlite3`, no `electron-rebuild`.
- `app.dock.hide()` + `LSUIElement: true` in `electron-builder.yml` under `mac.extendInfo`. Bundle id **`com.bpotter.workweekbuddy`, frozen now** — changing it later resets every TCC grant.
- `mac.target: dir`, `mac.hardenedRuntime: true`, and **no `com.apple.security.app-sandbox` entitlement anywhere** (trap 12).
- The renderer is served over a custom `app://` protocol (`protocol.handle`), never `file://` — Vite emits ESM and Electron cannot load ESM over `file://`.
- `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }`. **The Chromium renderer sandbox stays ON.** The thing that is banned is the macOS App Sandbox *entitlement*; they are unrelated, and confusing them either breaks the renderer's isolation or kills camera detection.

`eslint.config.js` must carry all four rule families, each with a fixture proving it fires:

```js
// eslint.config.js (excerpt)
rules: {
  'no-restricted-properties': ['error',
    { object: 'powerMonitor', property: 'getSystemIdleTime',
      message: 'Polluted by CGEventPost. Use lastRealSignalMs.' },
    { object: 'powerMonitor', property: 'getSystemIdleState',
      message: 'Polluted by CGEventPost. Use lastRealSignalMs.' },
  ],
  'no-restricted-syntax': ['error',
    { selector: "CallExpression[callee.name='CGEventSourceSecondsSinceLastEventType']",
      message: 'Polluted by CGEventPost. Use lastRealSignalMs.' },
    { selector: "Literal[value=/HIDIdleTime/]",
      message: 'Polluted by CGEventPost. Use lastRealSignalMs.' },
    { selector: "Literal[value=/kCGEventSourceStatePrivate/]",
      message: 'Blocks forever on macOS 26.5.1. Never call it.' },
  ],
}
```

plus a `files: ['src/core/**']` override with `'no-restricted-imports': ['error', { patterns: ['electron', 'electron/*', 'koffi', 'node:sqlite', '**/main/**'] }]`.

`src/main/cli.ts` parses the four flags from §2.7 and dispatches before `app.whenReady()` where possible.

**Definition of done**

```bash
nvm use && npm ci && npm run typecheck && npm run lint && npm run build
npx eslint test/lint-fixtures --no-ignore     # must report exactly 6 errors, one per fixture
codesign -d --entitlements - "out/mac-arm64/Work Week Buddy.app" 2>&1 | grep -c app-sandbox   # → 0
open "out/mac-arm64/Work Week Buddy.app"
```

Expect: `typecheck` and `lint` clean on `src/`; the fixture run failing with **one error per banned pattern**, each printing its custom message; `grep -c` printing `0`; the built app appearing as a **menu-bar icon with no Dock icon and no window**.

**Tests to write**

| File | Name |
|---|---|
| `test/lint-fixtures/README.md` | (documents that these files are *supposed* to fail lint) |
| `test/scaffold/cli.test.ts` | `parses --selftest --headless into {selftest:true, headless:true}` |
| `test/scaffold/cli.test.ts` | `rejects an unknown flag with exit code 2 rather than ignoring it` |
| `test/scaffold/degrade.test.ts` | `degrade() is idempotent and keeps the original sinceMs` |
| `test/scaffold/degrade.test.ts` | `recover() removes only the named code` |
| `test/scaffold/lint-rules.test.ts` | `every banned API has a lint fixture that actually fails` |

**Traps** — #7 (the lint rules are the mitigation; if a fixture does not fail, the rule is decorative), #12 (no App Sandbox entitlement — the `codesign` grep is the gate), #10 (the scaffold must not create any renderer timer).

**Size** — medium · **fakes only.** Any Mac.

---

### T1.2 · `native.ts` — every koffi declaration, in one file

**Depends on:** 1.1. **Blocks:** 1.3, 1.4, 1.5, 1.6.

**Files created**
- `src/main/native/native.ts` — **the only file in the repo that calls `koffi.load` or `koffi.func`**
- `src/main/native/constants.ts` — event types, field numbers, masks, the magic number
- `src/main/native/clock.ts` — mach → epoch conversion (see T1.3)
- `test/native/boot.test.ts` — exercises every declaration once, under Electron

**What to implement**

One module, ~45 declarations, grouped by framework, each with a one-line comment naming its header:

```ts
import koffi from 'koffi';

const CG  = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const CF  = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
const CM  = koffi.load('/System/Library/Frameworks/CoreMediaIO.framework/CoreMediaIO');
const CA  = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio');
const IOK = koffi.load('/System/Library/Frameworks/IOKit.framework/IOKit');
const AX  = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');

// ── opaque pointers ────────────────────────────────────────────────────────
export const CFMachPortRef      = koffi.pointer('CFMachPortRef',      koffi.opaque());
export const CFRunLoopSourceRef = koffi.pointer('CFRunLoopSourceRef', koffi.opaque());
export const CGEventRef         = koffi.pointer('CGEventRef',         koffi.opaque());
export const CGEventSourceRef   = koffi.pointer('CGEventSourceRef',   koffi.opaque());

// CGEventRef (*)(CGEventTapProxy, CGEventType, CGEventRef, void *)
export const CGEventTapCallBack = koffi.proto(
  'CGEventRef CGEventTapCallBack(void *proxy, uint32_t type, CGEventRef event, void *userInfo)');

export const CGEventTapCreate = CG.func(
  'CFMachPortRef CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options,'
  + ' uint64_t eventsOfInterest, CGEventTapCallBack *callback, void *userInfo)');

export const CGEventGetTimestamp = CG.func('uint64_t CGEventGetTimestamp(CGEventRef e)');
export const CGEventGetIntegerValueField =
  CG.func('int64_t CGEventGetIntegerValueField(CGEventRef e, uint32_t field)');
export const CGEventTapEnable    = CG.func('void CGEventTapEnable(CFMachPortRef tap, bool enable)');
export const CGEventTapIsEnabled = CG.func('bool CGEventTapIsEnabled(CFMachPortRef tap)');
// … CGEventSourceCreate, CGEventSourceSetUserData, CGEventCreate, CGEventSetType,
//    CGEventPost, CFMachPortCreateRunLoopSource, CFRunLoopAddSource, CFRunLoopGetMain,
//    CGGetEventTapList, CGPreflightListenEventAccess, CGRequestListenEventAccess,
//    CGPreflightPostEventAccess, CGRequestPostEventAccess, AXIsProcessTrusted,
//    CMIOObjectGetPropertyData / …DataSize, AudioObjectGetPropertyData / …DataSize,
//    IOPMAssertionCreateWithName, IOPMAssertionRelease,
//    IORegistryEntryFromPath, IORegistryEntryCreateCFProperty, CFStringGetCString,
//    mach_absolute_time, mach_timebase_info
```

Rules for this file, and they are absolute:

- **Every declaration is exercised exactly once by `test/native/boot.test.ts`.** koffi prototypes are string-typed; a wrong signature is a segfault, not a compile error. The boot test is the only compiler this file gets.
- **`CGEventGetIntegerValueField` returns `int64_t`, and koffi hands it back as a JS `number`.** Declare it `int64_t`, never compare its result to a `BigInt` literal (trap 4), and route every field read through one helper that asserts the type:

```ts
export function eventField(ev: unknown, field: number): number {
  const v = CGEventGetIntegerValueField(ev, field);
  if (typeof v !== 'number') {
    throw new Error(
      `koffi returned ${typeof v} for field ${field}; the ours-vs-theirs comparison ` +
      `would be silently false and our own jiggle would count as human input`);
  }
  return v;
}
```

- Callback trampolines must be **retained on a module-level array** (`const RETAINED: unknown[] = []`) or V8 collects them and the tap dies with no error and no events.
- `kCGEventSourceStatePrivate` is **not declared in this file at all.** A symbol that does not exist cannot be called (trap 11).
- `constants.ts` carries every number, named once:

```ts
export const kCGSessionEventTap = 1, kCGHeadInsertEventTap = 0, kCGEventTapOptionListenOnly = 1;
export const kCGEventSourceUnixProcessID = 41, kCGEventSourceUserData = 42;
export const kCGEventTapDisabledByTimeout = 0xFFFFFFFE, kCGEventTapDisabledByUserInput = 0xFFFFFFFF;
export const WWB_MAGIC = 0x57574B31;             // 'WWK1' — a number, never a BigInt literal
export const EVT = { leftMouseDown:1, leftMouseUp:2, rightMouseDown:3, rightMouseUp:4,
  mouseMoved:5, leftMouseDragged:6, rightMouseDragged:7, keyDown:10, keyUp:11,
  flagsChanged:12, scrollWheel:22, tabletPointer:23, tabletProximity:24,
  otherMouseDown:25, otherMouseUp:26, otherMouseDragged:27 } as const;
export const KEYBOARD_BITS = (1n << 10n) | (1n << 11n) | (1n << 12n);
export const TAP_MASK =
  (1n<<1n)|(1n<<2n)|(1n<<3n)|(1n<<4n)|(1n<<6n)|(1n<<7n)|
  KEYBOARD_BITS|(1n<<22n)|(1n<<25n)|(1n<<26n)|(1n<<27n);
```

`mouseMoved` (5) is **deliberately excluded** from `TAP_MASK`: clicks, drags and scroll are ample evidence of a human, and excluding move takes the worst-case callback rate from ~300/s to ~20/s. Say so in a comment; do not re-add it.

**Definition of done**

```bash
npm run test:native      # electron-vite build, then electron --headless running the boot test
```

Expect no segfault and stdout ending:

```
GATE 1.2 PASS  45/45 koffi declarations exercised, 0 segfaults
```

**Tests to write**

| File | Name |
|---|---|
| `test/native/boot.test.ts` | `every exported koffi declaration is invoked at least once without crashing` |
| `test/native/boot.test.ts` | `eventField returns a JS number, not a BigInt` |
| `test/native/boot.test.ts` | `TAP_MASK contains keyDown, keyUp and flagsChanged` |
| `test/native/boot.test.ts` | `TAP_MASK does not contain mouseMoved` |
| `test/native/boot.test.ts` | `WWB_MAGIC is a number and equals 0x57574B31` |
| `test/native/boot.test.ts` | `kCGEventSourceStatePrivate is not exported from native.ts` |
| `test/native/boot.test.ts` | `callback trampolines are retained on a module-level array` |

**Traps** — #4 (the `typeof` assertion lives here, not in the caller), #11 (absent by construction), #3 (the mask constant is defined here once and asserted here).

**Size** — medium · **requires a real Mac.** koffi loads real frameworks; there is nothing to fake.

