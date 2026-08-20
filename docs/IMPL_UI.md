# IMPL_UI — main process, IPC, tray, and the dashboard

**What this document is.** The spec says what and why. This says **what to type**. Every type name, channel name, file path and function signature below is normative. If two agents would otherwise make different defensible choices, the choice is made here.

**Read first:** `AGENTS.md`, `docs/PRD.md` §5–§6, `docs/ARCHITECTURE.md` §7, `docs/MACOS.md` §6, `design/README.md`.

---

## 0. Scope

| This document owns | This document does **not** own |
|---|---|
| `src/main/**` — process lifecycle, windows, tray, menu, power, protocol, autostart, IPC handlers | `src/main/native.ts` (koffi) → `docs/IMPL_NATIVE.md` |
| `src/preload/index.ts` | `src/core/**` (the reducer) → `docs/IMPL_CORE.md` |
| `src/shared/**` — the IPC contract + pure formatters | `src/main/store.ts`, `sync.ts`, `metrics.ts` bodies → `docs/IMPL_DATA.md` |
| `src/renderer/**` — the dashboard, onboarding, doctor panel | The Worker → `docs/IMPL_SYNC.md` |

Everything this document owns talks to the rest of the app through **one interface**: `AppRuntime` (§1.2). Nothing in `src/main/index.ts`, `tray.ts`, `ipc.ts` or the renderer imports the store, the reducer, or `native.ts` directly.

### 0.1 Non-negotiables that this layer can break

Each of these produces a plausible-looking wrong number, not an error.

1. **Every duration displayed anywhere is `lastSignalMs − openedAtMs`.** Never `now − openedAtMs`. Only "last signal *N*s ago" is allowed to read `now`. (§3.1)
2. **The 15-minute deadline never crosses IPC.** `LiveStatus.deadlineMs` is display-only and no renderer code may schedule anything from it. `AGENTS.md` trap #10.
3. **The renderer has no database handle, no `node:sqlite`, no `fs`, no `electron`.** Three enforcement layers in §2.8.
4. **`sandbox: true` requires a CommonJS preload.** An ESM preload under sandbox silently fails to load and `window.wwb` is `undefined`. (§1.10)
5. **Chromium's renderer sandbox is not App Sandbox.** `sandbox: true` on `webPreferences` is required. macOS App Sandbox is banned (`AGENTS.md` #12). Do not confuse them; do not "fix" one by disabling the other.
6. **A missing permission must be loud everywhere at once** — banner, tray icon, tray menu item, doctor panel. Never a silent `0`. (§4.5)
7. **`—` means no data. `0` means zero hours.** They are different pixels. Metrics types are `number | null` for this reason.
8. **Never `toISOString().slice(0, 10)`.** That is UTC. `design/mock-data.reference.ts:28` does exactly this; do not copy it into the port. Use `localDateString()` (§3.3), which matches SQLite's `date('now','localtime')`.

### 0.2 File map

```
src/
  shared/                       # pure TS. No electron, no node builtins. Importable by all three processes.
    ipc-types.ts                # §2.4  the contract
    format.ts                   # §3.3  pure formatters + calendar arithmetic
    window.d.ts                 # §2.5  the window.wwb declaration
  main/
    index.ts                    # §1.3  entry: lock, protocol, ready, power, quit
    runtime.ts                  # §1.2  the AppRuntime interface (the seam)
    protocol.ts                 # §1.4  app:// + the CSP header
    windows.ts                  # §1.5  dashboard + onboarding factories
    menu.ts                     # §1.6  minimal app menu (⌘C/⌘V/⌘W/⌘Q)
    tray.ts                     # §3.4
    ipc.ts                      # §2.6  handler registration + sender validation
    permissions.ts              # §4.3
    autostart.ts                # §1.7  the LaunchAgent plist
    cli.ts                      # §1.3  --selftest / --doctor / --install-launch-agent
    settings.ts                 # §1.11 main-side JSON settings (NOT localStorage)
    log.ts
  preload/
    index.ts                    # §2.5
  renderer/
    index.html                  # §5.5
    public/theme-boot.js        # §5.5  the FOUC killer
    src/
      main.tsx                  # §5.6  hash router: #/ and #/onboarding
      App.tsx                   # §5.7  ported from design/App.reference.tsx
      Onboarding.tsx            # §4.6
      DoctorPanel.tsx           # §6.3
      DegradedBanner.tsx        # §4.5
      components/theme-provider.tsx   # copied VERBATIM from design/
      components/ui/**                # shadcn
      lib/ipc.ts                # §2.7  the typed client + hooks
      lib/use-resolved-theme.ts # §5.2  the colorScheme fix
      index.css                 # copied VERBATIM from design/index.css
```

---

## 1. The Electron main process

### 1.1 Boot order

Order is load-bearing. Each step is where it is for a reason.

| # | Step | Why here |
|---|---|---|
| 1 | `app.setName('Work Week Buddy')` | Before anything reads `app.getPath('userData')`, which is derived from the name. |
| 2 | `protocol.registerSchemesAsPrivileged([...])` | **Must be at module scope, before `app.whenReady()`.** Called after ready it silently does nothing and every ESM import in the renderer 404s. |
| 3 | `readCliMode(process.argv)` | `--selftest` / `--doctor` must not take the single-instance lock — they run alongside a live instance. |
| 4 | `app.requestSingleInstanceLock()` (normal mode only) | Before ready, so the loser exits before it touches the DB. Use **`app.exit(0)`, not `app.quit()`** — `quit()` fires `before-quit`, which would close the *running* instance's interval from the wrong process. |
| 5 | `app.whenReady()` | Native calls need a WindowServer connection; being a ready GUI app is the guarantee. |
| 6 | `app.dock?.hide()` | Belt-and-braces for `npm run dev`, where `LSUIElement` from `electron-builder` is not applied. |
| 7 | `registerAppProtocol()` | Before any window is created. |
| 8 | `settings.load()` → `runtime.start()` | The runtime opens the DB, recovers the crash journal, creates the tap. Everything below reads its state. |
| 9 | `registerIpcHandlers(runtime, …)` | Before a window can exist and send anything. |
| 10 | `new TrayController(...).refresh('boot')` | The tray is the app. It exists before any window and outlives every window. |
| 11 | `wirePowerMonitor(runtime, tray)` | |
| 12 | Onboarding **only if** a permission is missing; otherwise no window at all | First launch after a clean install shows onboarding. A normal launch shows nothing. |

### 1.2 `src/main/runtime.ts` — the seam

This interface is the entire contract between this document and the rest of the app. Implement it in `src/main/runtime.impl.ts`; that file belongs to `docs/IMPL_CORE.md` / `IMPL_DATA.md`.

```ts
// src/main/runtime.ts
import type {
  DoctorReport, EndReason, FlushResult, LiveStatus, MetricsBundle, MetricsPolicy,
  PermissionKey, PermissionSnapshot, SelfTestResult, ToggleChange, Toggles,
} from "../shared/ipc-types"

/** Everything main-process UI code is allowed to know about the app. */
export interface AppRuntime {
  readonly machineId: string

  /** Opens the DB, recovers the crash journal, creates the tap, arms the deadline. */
  start(): Promise<void>
  /** Closes any open interval with `reason`, flushes best-effort, releases the tap. Idempotent. */
  stop(reason: EndReason): Promise<void>

  /** Synchronous, cheap, allocation-light. Called on every tray refresh. */
  liveStatus(): LiveStatus

  metrics(policy: MetricsPolicy): Promise<MetricsBundle>

  toggles(): Toggles
  /**
   * Resolves ONLY after the effect is durable:
   *  - jiggler on/off  → the interval boundary is committed to `work_interval`
   *                       and the successor interval is open (or none, if idle)
   *  - paused = true   → the open interval is closed with end_reason='paused'
   *  - keepAwake       → the IOPMAssertion is created/released
   * Never fire-and-forget: the tray reads liveStatus() immediately afterwards.
   */
  setToggle(change: ToggleChange): Promise<Toggles>

  permissions(): PermissionSnapshot
  refreshPermissions(): Promise<PermissionSnapshot>
  requestPermission(which: PermissionKey): Promise<PermissionSnapshot>

  flushNow(): Promise<FlushResult>
  doctor(): Promise<DoctorReport>
  selfTest(): Promise<SelfTestResult>

  /** epoch ms of the suspend, and of the resume. The runtime decides sleep vs idle_timeout. */
  onSuspend(atMs: number): Promise<void>
  onResume(atMs: number, suspendedAtMs: number | null): Promise<void>
  onScreenLock(atMs: number): void
  onScreenUnlock(atMs: number): void

  on(event: "change", cb: (kind: RuntimeChange) => void): () => void
}

export type RuntimeChange =
  | "interval-open"
  | "interval-close"
  | "signal"          // debounced to ≤1/s by the runtime; the tray ignores it
  | "toggles"
  | "permissions"
  | "tap-health"
  | "sync"
  | "rows-pulled"
```

**`RuntimeChange` is the only push source.** The tray and the IPC push layer both subscribe to it. Nothing else in main polls the runtime.

### 1.3 `src/main/index.ts` — complete

```ts
// src/main/index.ts
import { app, BrowserWindow, dialog, powerMonitor, protocol } from "electron"
import { readCliMode } from "./cli"
import { registerIpcHandlers, pushAll, pushToAllWindows } from "./ipc"
import { startPermissionPoll } from "./permissions"
import { installLaunchAgent, uninstallLaunchAgent, verifyLaunchAgent } from "./autostart"
import { buildAppMenu } from "./menu"
import { APP_SCHEME, registerAppProtocol } from "./protocol"
import { createRuntime } from "./runtime.impl"
import { settings } from "./settings"
import { TrayController } from "./tray"
import { closeAllWindows, showDashboard, showOnboarding } from "./windows"
import { log } from "./log"
import type { AppRuntime } from "./runtime"

app.setName("Work Week Buddy")

// ── 2. MUST run at module scope, before app.whenReady() ──────────────────────
// Registered after ready, this is a silent no-op and every ESM import in the
// renderer 404s with no console error worth reading.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,        // gives app:// a real origin, required for ESM + CSP
      secure: true,          // treated as a secure context
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

const mode = readCliMode(process.argv)

// ── 3/4. Utility modes run beside a live instance and must NOT take the lock ─
if (mode.kind === "normal") {
  if (!app.requestSingleInstanceLock()) {
    // exit(), not quit(): quit() would run before-quit and close the RUNNING
    // instance's interval from this doomed process.
    app.exit(0)
  }
  app.on("second-instance", () => {
    void showDashboard()
  })
}

let runtime: AppRuntime | null = null
let tray: TrayController | null = null
let quitting = false
let suspendedAtMs: number | null = null

app.whenReady().then(async () => {
  app.dock?.hide()                       // no-op when LSUIElement is applied; matters in dev

  switch (mode.kind) {
    case "selftest": {
      const rt = await createRuntime({ readOnly: true })
      const result = await rt.selfTest()
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      app.exit(result.passed ? 0 : 1)     // HARD GATE for scripts/install.sh
      return
    }
    case "doctor": {
      const rt = await createRuntime({ readOnly: true })
      const report = await rt.doctor()
      process.stdout.write(JSON.stringify(report, null, 2) + "\n")
      app.exit(report.allGreen ? 0 : 1)
      return
    }
    case "install-launch-agent":
      await installLaunchAgent()
      app.exit(0)
      return
    case "uninstall-launch-agent":
      await uninstallLaunchAgent()
      app.exit(0)
      return
    case "normal":
      break
  }

  registerAppProtocol()
  buildAppMenu()
  await settings.load()

  runtime = await createRuntime({ readOnly: false })
  await runtime.start()

  registerIpcHandlers(runtime)

  tray = new TrayController(runtime)
  tray.refresh("boot")

  // One subscription fans out to the tray and to every open window.
  runtime.on("change", (kind) => {
    tray?.onRuntimeChange(kind)
    pushToAllWindows(runtime!, kind)
  })

  wirePowerMonitor()

  void verifyLaunchAgent()                // records into DoctorReport.autostart; never prompts

  // First launch after install: the permissions are missing, so say so immediately.
  // A normal launch opens no window at all.
  const perms = await runtime.refreshPermissions()
  if (!perms.keyboardBitsGranted || perms.accessibility !== "granted") {
    if (!settings.get("onboardingDismissed") || !perms.keyboardBitsGranted) {
      await showOnboarding()
      // 1 Hz TCC read, alive only while that window exists, hard stop at 45 s.
      // Lives in MAIN because the onboarding window spends its life behind
      // System Settings and hidden renderer timers collapse (trap #10).
      startPermissionPoll((snap) => {
        pushAll("wwb:push:permissions", snap)
        tray?.refresh("permissions")
      })
    }
  }
})

// ── The window is a view, not the app ───────────────────────────────────────
app.on("window-all-closed", () => {
  // Deliberately empty. Closing the dashboard must not stop tracking and must
  // not freeze the tray. See test UI-T01.
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void showDashboard()
})

// ── Graceful shutdown ───────────────────────────────────────────────────────
app.on("before-quit", (e) => {
  if (quitting || !runtime) return
  e.preventDefault()
  quitting = true
  void (async () => {
    try {
      await withTimeout(runtime!.stop("app_quit"), 4000)
    } catch (err) {
      log.error("stop() on quit failed", err)
    } finally {
      tray?.destroy()
      closeAllWindows()
      app.exit(0)
    }
  })()
})

function wirePowerMonitor(): void {
  powerMonitor.on("suspend", () => {
    const at = Date.now()
    suspendedAtMs = at
    // Sleep does NOT close the interval. The countdown simply does not run;
    // on resume the wall-clock comparison decides. ARCHITECTURE §3.4.
    void runtime?.onSuspend(at)
  })

  powerMonitor.on("resume", () => {
    const at = Date.now()
    const from = suspendedAtMs
    suspendedAtMs = null
    void (async () => {
      // Order matters: re-evaluate the deadline (may close an interval at the
      // pre-sleep signal) BEFORE flushing, so the closed row is in the outbox.
      await runtime?.onResume(at, from)
      tray?.refresh("resume")
      await runtime?.flushNow()
    })()
  })

  powerMonitor.on("lock-screen", () => runtime?.onScreenLock(Date.now()))
  powerMonitor.on("unlock-screen", () => {
    runtime?.onScreenUnlock(Date.now())
    tray?.refresh("unlock")
  })

  // macOS delivers this on logout/restart/shutdown. There is no reliable
  // preventDefault here on darwin, so keep the handler short and synchronous-ish.
  powerMonitor.on("shutdown", () => {
    quitting = true
    void runtime?.stop("shutdown").finally(() => app.exit(0))
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ])
}

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err)
  dialog.showErrorBox("Work Week Buddy", `Unexpected error:\n${String(err)}`)
})
```

**Power events, stated as a table** — because "what closes an interval" is exactly the class of decision that goes wrong quietly.

| Event | Closes the interval? | `end_reason` | Also does |
|---|---|---|---|
| `suspend` | **No** | — | journals `open_interval`, best-effort flush |
| `resume` | Only if the deadline passed while asleep | `sleep` (not `idle_timeout` — the distinction is diagnostic and free) | re-reads camera/mic levels, re-checks tap health, flush, pull, tray refresh |
| `lock-screen` | **No** — matches Slack, PRD §3.2 | — | journal only |
| `unlock-screen` | No | — | re-evaluate deadline, tray refresh |
| `shutdown` | Yes | `shutdown` | — |
| `before-quit` | Yes | `app_quit` | 4 s timeout then hard exit |
| jiggler toggle | Yes, then reopens | `paused`? **no** — see §3.5 | writes a homogeneous row |
| pause toggle on | Yes | `paused` | |

### 1.4 `src/main/protocol.ts` — `app://` and the CSP

```ts
// src/main/protocol.ts
import { net, protocol } from "electron"
import { existsSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import { pathToFileURL } from "node:url"

export const APP_SCHEME = "app"
export const APP_HOST = "wwb"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * Production CSP. Set HERE and nowhere else.
 *
 * Do NOT also add a <meta http-equiv="Content-Security-Policy"> to index.html:
 * two policies intersect, and the day someone edits one and not the other,
 * Recharts stops rendering with a console message nobody reads.
 *
 * style-src 'unsafe-inline' is REQUIRED and is not laziness:
 *   - Recharts writes inline style attributes on every <path>/<g> it draws
 *   - @floating-ui (shadcn dropdowns, chart tooltips, react-activity-calendar
 *     tooltips) positions with inline transforms
 * Both land under style-src-attr, which 'unsafe-inline' on style-src covers.
 * script-src stays 'self' — the FOUC killer is a real file, not an inline tag.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

export function registerAppProtocol(): void {
  const root = join(__dirname, "../renderer")   // out/main → out/renderer

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response("not found", { status: 404 })

    // Path traversal guard: resolve, then prove it is still under root.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "")
    const filePath = normalize(join(root, rel === "" ? "index.html" : rel))
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response("forbidden", { status: 403 })
    }
    if (!existsSync(filePath)) return new Response("not found", { status: 404 })

    // net.fetch on a file:// URL gives us correct Content-Type for free.
    const res = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(res.headers)
    headers.set("Content-Security-Policy", CSP)
    headers.set("X-Content-Type-Options", "nosniff")
    return new Response(res.body, { status: res.status, headers })
  })
}
```

**Why a custom scheme at all:** Vite emits ESM. Electron cannot load ESM over `file://` — the module graph fails with a CORS-shaped error that reads like a bundler bug. `app://` with `standard: true` gives the renderer a real origin, which also makes the CSP and `localStorage` (used by the theme provider) behave normally.

**Dev has no CSP.** `electron-vite` serves `http://localhost:5173` in dev and this handler is never reached. That is why ROADMAP M6 gate (e) and (f) say *the built app*. Testing CSP in dev proves nothing.

### 1.5 `src/main/windows.ts` — complete

```ts
// src/main/windows.ts
import { BrowserWindow, shell } from "electron"
import { join } from "node:path"
import { APP_ORIGIN } from "./protocol"
import { settings } from "./settings"

const PRELOAD = join(__dirname, "../preload/index.js")   // CJS — see §1.10
const isDev = !!process.env.ELECTRON_RENDERER_URL

let dashboard: BrowserWindow | null = null
let onboarding: BrowserWindow | null = null

function baseWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,   // required
    nodeIntegration: false,   // required
    sandbox: true,            // Chromium renderer sandbox. NOT macOS App Sandbox.
    webviewTag: false,
    spellcheck: false,
    devTools: isDev,
  }
}

function load(win: BrowserWindow, hash: string): Promise<void> {
  return isDev
    ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html#${hash}`)
    : win.loadURL(`${APP_ORIGIN}/index.html#${hash}`)
}

function lockDownNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !url.startsWith("http://localhost:")) e.preventDefault()
  })
  win.webContents.on("will-attach-webview", (e) => e.preventDefault())
}

export async function showDashboard(): Promise<BrowserWindow> {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show()
    dashboard.focus()
    return dashboard
  }

  dashboard = new BrowserWindow({
    width: 1100,
    height: 860,
    // 880 is not a round number. The 53-week heatmap is ~745 px and does not
    // shrink. At 880: 880 − 64 (page px-8) − 40 (card px-5) = 776 px of inner
    // width, i.e. 31 px of headroom. Below 880 the overflow-x-auto wrapper
    // (App.tsx line 206) starts scrolling. design/README.md.
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: "Work Week Buddy",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    // Painted before the renderer's first frame. Read from main-side settings,
    // because main cannot read the renderer's localStorage. Mirrored by the
    // renderer on every theme change — see useThemeMirror() in §5.7.
    backgroundColor: settings.get("windowBackground"),
    webPreferences: baseWebPreferences(),
  })

  lockDownNavigation(dashboard)
  dashboard.once("ready-to-show", () => dashboard?.show())
  // Destroy, do not hide. ARCHITECTURE §1: "the renderer only exists while the
  // dashboard window is open." This is what M6 gate (d) measures.
  dashboard.on("closed", () => { dashboard = null })

  await load(dashboard, "/")
  return dashboard
}

export async function showOnboarding(): Promise<BrowserWindow> {
  if (onboarding && !onboarding.isDestroyed()) {
    onboarding.show(); onboarding.focus(); return onboarding
  }
  onboarding = new BrowserWindow({
    width: 560, height: 640,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    show: false, title: "Permissions",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: settings.get("windowBackground"),
    webPreferences: baseWebPreferences(),
  })
  lockDownNavigation(onboarding)
  onboarding.once("ready-to-show", () => onboarding?.show())
  onboarding.on("closed", () => { onboarding = null })
  await load(onboarding, "/onboarding")
  return onboarding
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboarding && !onboarding.isDestroyed() ? onboarding : null
}

export function closeAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
}
```

### 1.6 `src/main/menu.ts`

An `LSUIElement` app still activates and still shows its menu bar when a window is key. Without a menu, **⌘C, ⌘V and ⌘A do not work in the dashboard** — a bug that reads as "Electron is broken".

```ts
// src/main/menu.ts
import { app, Menu } from "electron"
import { showDashboard } from "./windows"

export function buildAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Open Dashboard", click: () => void showDashboard() },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { type: "separator" },
        { role: "quit" },            // ⌘Q → before-quit → runtime.stop('app_quit')
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },           // ⌘W closes the window; tracking continues
      ],
    },
  ]))
}
```

### 1.7 `src/main/autostart.ts` — the LaunchAgent

**One autostart mechanism, ever.** Do **not** call `app.setLoginItemSettings()`. It registers a *second*, independent launch path; both fire at login, the second loses the single-instance lock and exits, and the doctor panel then disagrees with reality. The plist is the only authority.

```ts
// src/main/autostart.ts
import { execFile } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export const AGENT_LABEL = "com.bpotter.workweekbuddy"
export const AGENT_PATH = join(homedir(), "Library/LaunchAgents", `${AGENT_LABEL}.plist`)
/** Frozen. TCC grants bind to bundle id + designated requirement + on-disk path. */
export const APP_PATH = "/Applications/Work Week Buddy.app"
const EXEC = `${APP_PATH}/Contents/MacOS/Work Week Buddy`

function plist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${EXEC}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Restart on a crash, but NOT after a clean ⌘Q. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <!-- GUI session only. CGEventSource* calls hang with no WindowServer
       connection, which is why NON_GOALS #6 bans a LaunchDaemon. -->
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${homedir()}/Library/Logs/WorkWeekBuddy/agent.out.log</string>
  <key>StandardErrorPath</key><string>${homedir()}/Library/Logs/WorkWeekBuddy/agent.err.log</string>
</dict>
</plist>
`
}

export async function installLaunchAgent(): Promise<void> {
  await mkdir(join(homedir(), "Library/Logs/WorkWeekBuddy"), { recursive: true })
  await mkdir(join(homedir(), "Library/LaunchAgents"), { recursive: true })
  await writeFile(AGENT_PATH, plist(), "utf8")
  const uid = process.getuid?.() ?? 501
  await run("/bin/launchctl", ["bootout", `gui/${uid}/${AGENT_LABEL}`]).catch(() => {})
  await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, AGENT_PATH])
}

export async function uninstallLaunchAgent(): Promise<void> {
  const uid = process.getuid?.() ?? 501
  await run("/bin/launchctl", ["bootout", `gui/${uid}/${AGENT_LABEL}`]).catch(() => {})
  await rm(AGENT_PATH, { force: true })
}

export interface LaunchAgentState {
  installed: boolean
  loaded: boolean
  plistPath: string
  execPath: string
  execMatchesRunningApp: boolean
}

export async function verifyLaunchAgent(): Promise<LaunchAgentState> {
  let installed = false
  try { await readFile(AGENT_PATH, "utf8"); installed = true } catch { /* absent */ }
  const uid = process.getuid?.() ?? 501
  const loaded = await run("/bin/launchctl", ["print", `gui/${uid}/${AGENT_LABEL}`])
    .then(() => true).catch(() => false)
  return {
    installed, loaded,
    plistPath: AGENT_PATH,
    execPath: EXEC,
    execMatchesRunningApp: process.execPath === EXEC,
  }
}
```

`execMatchesRunningApp: false` is exactly the "you are running the dev build, your grants are the dev bundle's" case from `AGENTS.md`. The doctor panel surfaces it (§6).

### 1.8 `src/main/settings.ts`

Main-side settings live in a JSON file, **not** in the renderer's `localStorage`. The renderer can be closed for a week; the tray still needs to know whether the jiggler is on.

```ts
// src/main/settings.ts
import { app } from "electron"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface MainSettings {
  machineLabel: string
  idleTimeoutMin: number                 // 10–15, PRD §7
  jigglerPausePrompt: "ask" | "never"
  windowBackground: string               // '#FFFFFF' | '#191919' — mirrored from the renderer
  onboardingDismissed: boolean
  meetingApps: string[]                  // bundle ids, user-editable, PRD §3.5
  micIgnoreApps: string[]
  heatmapThresholdsH: [number, number, number]
  minIntervalS: number
  countJigglerTime: 0 | 1
  graceS: number
}

const DEFAULTS: MainSettings = {
  machineLabel: "",
  idleTimeoutMin: 15,
  jigglerPausePrompt: "ask",
  windowBackground: "#FFFFFF",
  onboardingDismissed: false,
  meetingApps: [
    "us.zoom.xos", "com.tinyspeck.slackmacgap", "com.microsoft.teams2",
    "com.cisco.webexmeetingsapp", "com.hnc.Discord",
  ],
  micIgnoreApps: ["com.wisprflow.flow", "com.openwhispr.app"],
  heatmapThresholdsH: [2, 5, 8],
  minIntervalS: 90,
  countJigglerTime: 0,
  graceS: 0,
}

class SettingsStore {
  private data: MainSettings = { ...DEFAULTS }

  /**
   * LAZY, deliberately. ES imports execute before the importing module's body,
   * so a field initialiser here would call app.getPath() BEFORE index.ts runs
   * app.setName() — and userData is derived from the name. The result is a
   * settings file in the wrong directory, silently, with defaults everywhere.
   */
  private path(): string { return join(app.getPath("userData"), "settings.json") }

  async load(): Promise<void> {
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(await readFile(this.path(), "utf8")) }
    } catch { this.data = { ...DEFAULTS } }
  }
  get<K extends keyof MainSettings>(k: K): MainSettings[K] { return this.data[k] }
  all(): Readonly<MainSettings> { return this.data }
  async set<K extends keyof MainSettings>(k: K, v: MainSettings[K]): Promise<void> {
    this.data[k] = v
    await mkdir(dirname(this.path()), { recursive: true })
    await writeFile(this.path(), JSON.stringify(this.data, null, 2), "utf8")
  }
}

export const settings = new SettingsStore()
```

### 1.9 `src/main/cli.ts`

```ts
// src/main/cli.ts
export type CliMode =
  | { kind: "normal"; hidden: boolean }
  | { kind: "selftest" }
  | { kind: "doctor" }
  | { kind: "install-launch-agent" }
  | { kind: "uninstall-launch-agent" }

export function readCliMode(argv: readonly string[]): CliMode {
  const has = (f: string) => argv.includes(f)
  if (has("--selftest")) return { kind: "selftest" }
  if (has("--doctor")) return { kind: "doctor" }
  if (has("--install-launch-agent")) return { kind: "install-launch-agent" }
  if (has("--uninstall-launch-agent")) return { kind: "uninstall-launch-agent" }
  return { kind: "normal", hidden: has("--hidden") }
}
```

`--selftest` and `--doctor` open the DB **read-only** and never take the single-instance lock, so `scripts/install.sh` can gate on them while the app is already running. `--selftest` posts a tagged jiggle, so it requires Accessibility — run it after the grant, not before.

### 1.10 Build config — the two traps

```ts
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // TRAP: a sandboxed preload MUST be CommonJS. An ESM preload under
      // sandbox:true fails to load with no renderer error at all — window.wwb
      // is simply undefined and every IPC call throws "cannot read invoke".
      // Keep package.json WITHOUT "type": "module" and keep this explicit.
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.js" } },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: { alias: { "@": resolve("src/renderer/src") } },  // design/ imports use @/…
    plugins: [react()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
})
```

`electron-builder` config additions this document depends on:

```jsonc
"mac": {
  "target": "dir",
  "extendInfo": {
    "LSUIElement": 1                     // no dock icon, no app switcher entry
  }
},
"extraResources": ["resources/tray*.png"]
```

---

## 2. The IPC contract

### 2.1 Rules

1. **The renderer never mutates state directly.** Every mutation is an `invoke` that returns the **new full state object**, so the renderer never has to guess what changed.
2. **Every push payload is a complete snapshot**, never a delta. Deltas need ordering guarantees that IPC does not give you.
3. **Every timestamp on the wire is absolute epoch milliseconds.** Never a duration, never a pre-formatted string. The renderer formats; main never does. (Except the tray title, which main formats because there is no renderer.)
4. **Channel names are `wwb:<domain>:<verb>`**, listed once in `src/shared/ipc-types.ts`, and the preload allowlists them. No string literals anywhere else.
5. **Every handler validates its sender** (§2.6). A page that is not ours gets an error, not data.
6. **No `ipcRenderer.sendSync`.** It blocks the renderer and there is no case here that needs it.

### 2.2 Invoke channels — renderer → main

| Channel | Request | Response | Notes |
|---|---|---|---|
| `wwb:app:info` | `void` | `AppInfo` | version, machineId, machineLabel, tz, isPackaged, idleTimeoutMin |
| `wwb:status:get` | `void` | `LiveStatus` | cheap; safe to call on mount |
| `wwb:metrics:get` | `MetricsPolicy` | `MetricsBundle` | all six DATA_MODEL queries in one round trip |
| `wwb:toggles:get` | `void` | `Toggles` | |
| `wwb:toggles:set` | `ToggleChange` | `Toggles` | resolves **after** the effect is durable (§1.2) |
| `wwb:permissions:get` | `void` | `PermissionSnapshot` | cached, no syscalls |
| `wwb:permissions:refresh` | `void` | `PermissionSnapshot` | re-reads preflight + the granted mask |
| `wwb:permissions:request` | `PermissionKey` | `PermissionSnapshot` | preflight → request → immediate re-read (§4.1) |
| `wwb:permissions:openSettings` | `PermissionKey` | `void` | deep-links System Settings |
| `wwb:permissions:relaunch` | `void` | `never` | closes the interval, then relaunches (§4.4) |
| `wwb:onboarding:dismiss` | `void` | `void` | sets `onboardingDismissed`, closes the window |
| `wwb:doctor:get` | `void` | `DoctorReport` | |
| `wwb:doctor:selftest` | `void` | `SelfTestResult` | posts a tagged jiggle; needs Accessibility |
| `wwb:sync:flush` | `void` | `FlushResult` | manual "Sync now" |
| `wwb:machine:rename` | `{ label: string }` | `AppInfo` | |
| `wwb:settings:get` | `void` | `UiSettings` | the subset the renderer may see |
| `wwb:settings:set` | `Partial<UiSettings>` | `UiSettings` | includes `windowBackground` mirroring |
| `wwb:window:openDashboard` | `void` | `void` | |

### 2.3 Push channels — main → renderer

| Channel | Payload | Fires when |
|---|---|---|
| `wwb:push:status` | `LiveStatus` | interval open/close, toggle change, permission change, tap-health change, resume; plus a 30 s keepalive while a window exists |
| `wwb:push:toggles` | `Toggles` | any toggle change, from any source (tray or dashboard) |
| `wwb:push:permissions` | `PermissionSnapshot` | the 1 Hz onboarding poll, or any refresh |
| `wwb:push:metrics-stale` | `{ reason: "interval-close" \| "rows-pulled" }` | debounced 2 s in main; the renderer re-invokes `wwb:metrics:get` |
| `wwb:push:doctor` | `DoctorReport` | only while the doctor panel is open, every 10 s |

**Why `metrics-stale` instead of pushing the metrics:** the six queries take a bind-parameter policy the renderer owns (the grace-credit widget changes `graceS` live). Main does not know which policy the renderer is currently showing. Pushing an invalidation and letting the renderer re-ask is one round trip and zero divergence.

**Why status is not pushed at 1 Hz:** the renderer already has `openedAtMs` and `lastSignalMs` as absolute values. It ticks its own 1 Hz display timer and **recomputes from absolutes every tick** — so if that timer collapses (trap #10), the next tick still shows the right number. Never accumulate in the renderer.

### 2.4 `src/shared/ipc-types.ts` — complete

```ts
// src/shared/ipc-types.ts
// Pure types + const literals. No imports from 'electron', no node builtins.
// Imported by main, preload and renderer alike.

export type MachineId = string
export type LocalDate = string          // 'YYYY-MM-DD', local, never UTC

export type EndReason =
  | "idle_timeout" | "sleep" | "lock" | "shutdown"
  | "app_quit" | "paused" | "crash_recovered" | "tap_lost"

// ── live status ─────────────────────────────────────────────────────────────
export type TrackingState = "working" | "idle" | "paused"
export type SignalKind = "input" | "camera" | "mic"

export type DegradedReason =
  | "keyboard_permission_missing"    // the granted mask lost the keyboard bits
  | "accessibility_missing"          // jiggler cannot post
  | "tap_lost"                       // the watchdog found the tap dead
  | "relaunch_required"              // a grant landed but needs a restart to take effect
  | "sync_silent_72h"                // DATA_MODEL backup layer 4
  | "fingerprint_mismatch"           // backup layer 3
  | "db_unwritable"

export interface LiveStatus {
  asOfMs: number
  state: TrackingState
  /** first real signal of the open interval; null when idle */
  openedAtMs: number | null
  /** most recent signal of ANY kind that is not our own jiggle; null before the first */
  lastSignalMs: number | null
  lastSignalKind: SignalKind | null
  /** absolute epoch ms. DISPLAY ONLY — no renderer may schedule from this. */
  deadlineMs: number | null
  /** non-null while a camera/mic level is holding the interval open */
  heldOpenBy: SignalKind | null
  /** absolute epoch ms the hold is capped at (PRD §3.4), null when uncapped */
  heldUntilMs: number | null
  cameraOn: boolean
  micCapturing: boolean
  meetingAppRunning: boolean
  machineId: MachineId
  machineLabel: string
  /** closed, countable hours this local week. Excludes the open interval. */
  closedHoursThisWeek: number | null
  closedHoursToday: number | null
  jigglerOnForOpenInterval: boolean
  degraded: DegradedReason[]
}

// ── toggles ─────────────────────────────────────────────────────────────────
export interface Toggles {
  jiggler: boolean
  keepAwake: boolean
  paused: boolean
  /** false ⇒ the jiggler switch must render disabled with a reason */
  jigglerAvailable: boolean
  jigglerUnavailableReason: string | null
}
export type ToggleKey = "jiggler" | "keepAwake" | "paused"
export interface ToggleChange { key: ToggleKey; value: boolean; source: "tray" | "dashboard" }

// ── permissions ─────────────────────────────────────────────────────────────
export type PermissionKey = "inputMonitoring" | "accessibility"
export type PermissionState = "granted" | "denied" | "undetermined" | "unknown"

export interface PermissionSnapshot {
  checkedAtMs: number
  inputMonitoring: PermissionState
  accessibility: PermissionState
  /**
   * THE AUTHORITY. MACOS.md §6: which TCC bucket governs the keyboard bits is
   * disputed, so we do not trust either preflight — we read the granted mask
   * back off CGGetEventTapList and believe that.
   */
  keyboardBitsGranted: boolean
  flagsChangedBitGranted: boolean
  /** a grant landed but the live tap still lacks the bits ⇒ restart required */
  relaunchRequired: boolean
  /** true once the system prompt for that key has been consumed (one shot, ever) */
  promptConsumed: Record<PermissionKey, boolean>
  microphone: "not-required" | "prompted"   // M1 gate (g); 'prompted' is a defect
}

// ── metrics ─────────────────────────────────────────────────────────────────
export interface MetricsPolicy {
  minIntervalS: number                   // v_countable, default 90
  countJigglerTime: 0 | 1                // v_countable, PRD D1, default 0
  graceS: number                         // v_countable, default 0
  heatmapThresholdsH: [number, number, number]   // default [2,5,8] — see §5.2
}

export interface HeatmapDay { date: LocalDate; count: number; level: 0 | 1 | 2 | 3 | 4 }
export interface WeekBar { day: "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"; date: LocalDate; hours: number }
export interface MachineBreakdown {
  machineId: MachineId
  label: string
  hours: number
  intervals: number
  meetingHours: number
  jigglerHours: number
  /** hours ÷ Σ hours, computed in main so the renderer stays arithmetic-free */
  share: number
  lastSeenMs: number | null
}

export interface MetricsBundle {
  generatedAtMs: number
  policy: MetricsPolicy
  weekStart: LocalDate
  /** DATA_MODEL query 1 */
  week: { hours: number | null; prevHours: number | null }
  /** query 2 */
  interval: { avgMin: number | null; nIntervals: number }
  allTime: {
    avgMin: number | null; nIntervals: number
    hoursTracked: number | null; sinceDate: LocalDate | null
  }
  /** query 3 */
  longest: {
    singleHours: number | null; singleMachineLabel: string | null; singleDate: LocalDate | null
    mergedHours: number | null; mergedDate: LocalDate | null
  }
  heatmap: HeatmapDay[]        // query 4, 371 days
  weekBars: WeekBar[]          // 7 rows, Mon-first, zero-filled
  byMachine: MachineBreakdown[]  // query 5
  /** query 6, today */
  honesty: { date: LocalDate; naiveSumH: number | null; unionH: number | null }
}

// ── sync / doctor ───────────────────────────────────────────────────────────
export interface FlushResult {
  ok: boolean; attempted: number; confirmed: number
  pendingAfter: number; error: string | null; atMs: number
}

export interface TapHealth {
  created: boolean
  enabled: boolean
  grantedMaskHex: string
  keyboardBitsPresent: boolean
  flagsChangedBitPresent: boolean
  runLoopModes: Array<"default" | "common">
  eventsSinceLaunch: number
  lastEventMs: number | null
  disabledByTimeoutCount: number
  reEnabledCount: number
  tapLostRows: number
  lastWatchdogTickMs: number | null
}

export interface SelfTestResult {
  ranAtMs: number
  passed: boolean
  appVersion: string
  checks: Array<{ id: string; passed: boolean; detail: string }>
}

export interface DoctorReport {
  generatedAtMs: number
  allGreen: boolean
  app: { version: string; electron: string; bundleId: string; execPath: string; isPackaged: boolean; launchedAtMs: number }
  machine: { machineId: MachineId; label: string; osVersion: string; tz: string }
  permissions: PermissionSnapshot
  tap: TapHealth
  camera: { deviceCount: number; inUse: boolean; listenerRegistered: boolean; lastReadMs: number | null }
  mic: { inUse: boolean; meetingAppRunning: boolean; meetingApp: string | null; needsPermission: boolean | null }
  sync: {
    pendingRows: number; lastFlushOkMs: number | null; lastFlushError: string | null
    lastPullMs: number | null; watermark: number; lastCloudWriteMs: number | null
    silentForMs: number | null
  }
  fingerprint: {
    checkedAtMs: number | null; matched: boolean | null
    localCount: number | null; cloudCount: number | null
    localSha: string | null; cloudSha: string | null
  }
  backup: { lastPath: string | null; lastAtMs: number | null; ageDays: number | null; destination: "icloud" | "documents" | null; kept: number }
  selfTest: SelfTestResult | null
  db: { path: string; sizeBytes: number; rows: number; openIntervalPresent: boolean; integrityOk: boolean }
  autostart: { installed: boolean; loaded: boolean; plistPath: string; execMatchesRunningApp: boolean }
  codesign: { designatedRequirementSha256: string | null; valid: boolean | null }
}

export interface AppInfo {
  version: string; machineId: MachineId; machineLabel: string
  tz: string; isPackaged: boolean; idleTimeoutMin: number
}

export interface UiSettings {
  machineLabel: string
  idleTimeoutMin: number
  windowBackground: string
  meetingApps: string[]
  micIgnoreApps: string[]
  heatmapThresholdsH: [number, number, number]
  minIntervalS: number
  countJigglerTime: 0 | 1
  graceS: number
}

// ── the contract ────────────────────────────────────────────────────────────
export interface InvokeContract {
  "wwb:app:info": { req: void; res: AppInfo }
  "wwb:status:get": { req: void; res: LiveStatus }
  "wwb:metrics:get": { req: MetricsPolicy; res: MetricsBundle }
  "wwb:toggles:get": { req: void; res: Toggles }
  "wwb:toggles:set": { req: ToggleChange; res: Toggles }
  "wwb:permissions:get": { req: void; res: PermissionSnapshot }
  "wwb:permissions:refresh": { req: void; res: PermissionSnapshot }
  "wwb:permissions:request": { req: PermissionKey; res: PermissionSnapshot }
  "wwb:permissions:openSettings": { req: PermissionKey; res: void }
  "wwb:permissions:relaunch": { req: void; res: void }
  "wwb:onboarding:dismiss": { req: void; res: void }
  "wwb:doctor:get": { req: void; res: DoctorReport }
  "wwb:doctor:selftest": { req: void; res: SelfTestResult }
  "wwb:sync:flush": { req: void; res: FlushResult }
  "wwb:machine:rename": { req: { label: string }; res: AppInfo }
  "wwb:settings:get": { req: void; res: UiSettings }
  "wwb:settings:set": { req: Partial<UiSettings>; res: UiSettings }
  "wwb:window:openDashboard": { req: void; res: void }
}

export interface PushContract {
  "wwb:push:status": LiveStatus
  "wwb:push:toggles": Toggles
  "wwb:push:permissions": PermissionSnapshot
  "wwb:push:metrics-stale": { reason: "interval-close" | "rows-pulled" }
  "wwb:push:doctor": DoctorReport
}

export type InvokeChannel = keyof InvokeContract
export type PushChannel = keyof PushContract

/** The preload allowlist. A channel not in these arrays cannot cross the bridge. */
export const INVOKE_CHANNELS = [
  "wwb:app:info", "wwb:status:get", "wwb:metrics:get",
  "wwb:toggles:get", "wwb:toggles:set",
  "wwb:permissions:get", "wwb:permissions:refresh", "wwb:permissions:request",
  "wwb:permissions:openSettings", "wwb:permissions:relaunch",
  "wwb:onboarding:dismiss",
  "wwb:doctor:get", "wwb:doctor:selftest",
  "wwb:sync:flush", "wwb:machine:rename",
  "wwb:settings:get", "wwb:settings:set",
  "wwb:window:openDashboard",
] as const satisfies readonly InvokeChannel[]

export const PUSH_CHANNELS = [
  "wwb:push:status", "wwb:push:toggles", "wwb:push:permissions",
  "wwb:push:metrics-stale", "wwb:push:doctor",
] as const satisfies readonly PushChannel[]

export const DEFAULT_POLICY: MetricsPolicy = {
  minIntervalS: 90,
  countJigglerTime: 0,
  graceS: 0,
  heatmapThresholdsH: [2, 5, 8],
}
```

### 2.5 `src/preload/index.ts` — complete

```ts
// src/preload/index.ts
// CommonJS output. See §1.10 — an ESM preload under sandbox:true silently
// does not load and window.wwb is undefined.
import { contextBridge, ipcRenderer } from "electron"
import {
  INVOKE_CHANNELS, PUSH_CHANNELS,
  type InvokeChannel, type InvokeContract, type PushChannel, type PushContract,
} from "../shared/ipc-types"

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const pushSet = new Set<string>(PUSH_CHANNELS)

export interface WwbBridge {
  invoke<K extends InvokeChannel>(
    channel: K,
    payload: InvokeContract[K]["req"],
  ): Promise<InvokeContract[K]["res"]>

  /** Returns an unsubscribe function. Always call it from a useEffect cleanup. */
  on<K extends PushChannel>(channel: K, cb: (payload: PushContract[K]) => void): () => void
}

const bridge: WwbBridge = {
  invoke(channel, payload) {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`blocked invoke channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },

  on(channel, cb) {
    if (!pushSet.has(channel)) throw new Error(`blocked push channel: ${String(channel)}`)
    // Strip the IpcRendererEvent: it carries `sender`, which is a capability
    // we do not hand to page code.
    const listener = (_e: unknown, payload: unknown) => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
}

contextBridge.exposeInMainWorld("wwb", bridge)
```

```ts
// src/shared/window.d.ts
import type { WwbBridge } from "../preload"
declare global {
  interface Window { wwb: WwbBridge }
}
export {}
```

**Not exposed, deliberately:** `ipcRenderer` itself, `process`, `require`, any `send`/`sendSync`, any path, any DB handle. The bridge surface is two functions.

### 2.6 `src/main/ipc.ts` — complete

```ts
// src/main/ipc.ts
import { BrowserWindow, app, ipcMain, shell, type IpcMainInvokeEvent } from "electron"
import { APP_ORIGIN } from "./protocol"
import { settings } from "./settings"
import { getOnboardingWindow, showDashboard } from "./windows"
import { openPrivacyPane } from "./permissions"
import { log } from "./log"
import type { AppRuntime, RuntimeChange } from "./runtime"
import type {
  InvokeChannel, InvokeContract, LiveStatus, PushChannel, PushContract, UiSettings,
} from "../shared/ipc-types"

const isDev = !!process.env.ELECTRON_RENDERER_URL

/** A page that is not ours gets an error, not data. */
function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ""
  const ok = url.startsWith(APP_ORIGIN) || (isDev && url.startsWith("http://localhost:"))
  if (!ok) throw new Error(`untrusted IPC sender: ${url}`)
}

function handle<K extends InvokeChannel>(
  channel: K,
  fn: (payload: InvokeContract[K]["req"], e: IpcMainInvokeEvent) => Promise<InvokeContract[K]["res"]> | InvokeContract[K]["res"],
): void {
  ipcMain.handle(channel, async (e, payload) => {
    assertTrustedSender(e)
    try {
      return await fn(payload as InvokeContract[K]["req"], e)
    } catch (err) {
      log.error(`ipc ${channel} failed`, err)
      throw err                      // surfaces as a rejected promise in the renderer
    }
  })
}

export function push<K extends PushChannel>(win: BrowserWindow, channel: K, payload: PushContract[K]): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

export function pushAll<K extends PushChannel>(channel: K, payload: PushContract[K]): void {
  for (const w of BrowserWindow.getAllWindows()) push(w, channel, payload)
}

let staleTimer: NodeJS.Timeout | null = null
let statusKeepalive: NodeJS.Timeout | null = null

/** Called from the single runtime 'change' subscription in index.ts. */
export function pushToAllWindows(runtime: AppRuntime, kind: RuntimeChange): void {
  if (BrowserWindow.getAllWindows().length === 0) return

  switch (kind) {
    case "signal":
      return                                     // display timers cover this; do not spam IPC
    case "toggles":
      pushAll("wwb:push:toggles", runtime.toggles())
      pushAll("wwb:push:status", runtime.liveStatus())
      return
    case "permissions":
      pushAll("wwb:push:permissions", runtime.permissions())
      pushAll("wwb:push:status", runtime.liveStatus())
      return
    case "interval-close":
    case "rows-pulled":
      pushAll("wwb:push:status", runtime.liveStatus())
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        staleTimer = null
        pushAll("wwb:push:metrics-stale", {
          reason: kind === "rows-pulled" ? "rows-pulled" : "interval-close",
        })
      }, 2000)
      return
    default:
      pushAll("wwb:push:status", runtime.liveStatus())
  }
}

export function registerIpcHandlers(runtime: AppRuntime): void {
  const uiSettings = (): UiSettings => {
    const s = settings.all()
    return {
      machineLabel: s.machineLabel, idleTimeoutMin: s.idleTimeoutMin,
      windowBackground: s.windowBackground, meetingApps: s.meetingApps,
      micIgnoreApps: s.micIgnoreApps, heatmapThresholdsH: s.heatmapThresholdsH,
      minIntervalS: s.minIntervalS, countJigglerTime: s.countJigglerTime, graceS: s.graceS,
    }
  }

  handle("wwb:app:info", () => ({
    version: app.getVersion(),
    machineId: runtime.machineId,
    machineLabel: settings.get("machineLabel"),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    isPackaged: app.isPackaged,
    idleTimeoutMin: settings.get("idleTimeoutMin"),
  }))

  handle("wwb:status:get", () => runtime.liveStatus())
  handle("wwb:metrics:get", (policy) => runtime.metrics(policy))
  handle("wwb:toggles:get", () => runtime.toggles())
  handle("wwb:toggles:set", (change) => runtime.setToggle(change))

  handle("wwb:permissions:get", () => runtime.permissions())
  handle("wwb:permissions:refresh", () => runtime.refreshPermissions())
  handle("wwb:permissions:request", (which) => runtime.requestPermission(which))
  handle("wwb:permissions:openSettings", (which) => { openPrivacyPane(which) })
  handle("wwb:permissions:relaunch", async () => {
    await runtime.stop("app_quit")
    app.relaunch({ args: process.argv.slice(1) })
    app.exit(0)
    return undefined as never
  })

  handle("wwb:onboarding:dismiss", async () => {
    await settings.set("onboardingDismissed", true)
    getOnboardingWindow()?.close()
  })

  handle("wwb:doctor:get", () => runtime.doctor())
  handle("wwb:doctor:selftest", () => runtime.selfTest())
  handle("wwb:sync:flush", () => runtime.flushNow())

  handle("wwb:machine:rename", async ({ label }) => {
    await settings.set("machineLabel", label.trim().slice(0, 60))
    return {
      version: app.getVersion(), machineId: runtime.machineId,
      machineLabel: settings.get("machineLabel"),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      isPackaged: app.isPackaged, idleTimeoutMin: settings.get("idleTimeoutMin"),
    }
  })

  handle("wwb:settings:get", () => uiSettings())
  handle("wwb:settings:set", async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      await settings.set(k as never, v as never)
    }
    return uiSettings()
  })

  handle("wwb:window:openDashboard", async () => { await showDashboard() })

  // 30 s keepalive so a window that missed a push (created mid-change) converges.
  statusKeepalive = setInterval(() => {
    if (BrowserWindow.getAllWindows().length === 0) return
    pushAll("wwb:push:status", runtime.liveStatus())
  }, 30_000)
}
```

### 2.7 `src/renderer/src/lib/ipc.ts` — the typed client

```ts
// src/renderer/src/lib/ipc.ts
import * as React from "react"
import {
  DEFAULT_POLICY,
  type AppInfo, type DoctorReport, type FlushResult, type LiveStatus,
  type MetricsBundle, type MetricsPolicy, type PermissionKey, type PermissionSnapshot,
  type PushChannel, type PushContract, type ToggleChange, type Toggles, type UiSettings,
} from "@shared/ipc-types"

const wwb = window.wwb

export const ipc = {
  appInfo: () => wwb.invoke("wwb:app:info", undefined),
  status: () => wwb.invoke("wwb:status:get", undefined),
  metrics: (p: MetricsPolicy) => wwb.invoke("wwb:metrics:get", p),
  toggles: () => wwb.invoke("wwb:toggles:get", undefined),
  setToggle: (c: ToggleChange) => wwb.invoke("wwb:toggles:set", c),
  permissions: () => wwb.invoke("wwb:permissions:get", undefined),
  refreshPermissions: () => wwb.invoke("wwb:permissions:refresh", undefined),
  requestPermission: (k: PermissionKey) => wwb.invoke("wwb:permissions:request", k),
  openPrivacyPane: (k: PermissionKey) => wwb.invoke("wwb:permissions:openSettings", k),
  relaunch: () => wwb.invoke("wwb:permissions:relaunch", undefined),
  dismissOnboarding: () => wwb.invoke("wwb:onboarding:dismiss", undefined),
  doctor: () => wwb.invoke("wwb:doctor:get", undefined),
  selfTest: () => wwb.invoke("wwb:doctor:selftest", undefined),
  flush: () => wwb.invoke("wwb:sync:flush", undefined),
  renameMachine: (label: string) => wwb.invoke("wwb:machine:rename", { label }),
  settings: () => wwb.invoke("wwb:settings:get", undefined),
  setSettings: (p: Partial<UiSettings>) => wwb.invoke("wwb:settings:set", p),
  openDashboard: () => wwb.invoke("wwb:window:openDashboard", undefined),
} as const

function usePush<K extends PushChannel>(channel: K, cb: (p: PushContract[K]) => void): void {
  const ref = React.useRef(cb)
  ref.current = cb
  React.useEffect(() => wwb.on(channel, (p) => ref.current(p)), [channel])
}

/** Snapshot-on-mount + push. Never derives state from a previous state. */
export function useLiveStatus(): LiveStatus | null {
  const [status, setStatus] = React.useState<LiveStatus | null>(null)
  React.useEffect(() => { void ipc.status().then(setStatus) }, [])
  usePush("wwb:push:status", setStatus)
  return status
}

export function useToggles(): [Toggles | null, (key: ToggleChange["key"], value: boolean) => void] {
  const [toggles, setToggles] = React.useState<Toggles | null>(null)
  React.useEffect(() => { void ipc.toggles().then(setToggles) }, [])
  usePush("wwb:push:toggles", setToggles)
  const set = React.useCallback((key: ToggleChange["key"], value: boolean) => {
    // Optimistic, then authoritative. setToggle resolves only after the
    // interval boundary is durable, so the second setToggles is the truth.
    setToggles((t) => (t ? { ...t, [key]: value } : t))
    void ipc.setToggle({ key, value, source: "dashboard" }).then(setToggles)
  }, [])
  return [toggles, set]
}

export function useMetrics(policy: MetricsPolicy = DEFAULT_POLICY) {
  const [data, setData] = React.useState<MetricsBundle | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const key = JSON.stringify(policy)
  const reload = React.useCallback(() => {
    ipc.metrics(JSON.parse(key) as MetricsPolicy).then(setData, (e: Error) => setError(e.message))
  }, [key])
  React.useEffect(reload, [reload])
  usePush("wwb:push:metrics-stale", reload)
  return { data, error, reload }
}

export function usePermissions(): PermissionSnapshot | null {
  const [p, setP] = React.useState<PermissionSnapshot | null>(null)
  React.useEffect(() => { void ipc.permissions().then(setP) }, [])
  usePush("wwb:push:permissions", setP)
  return p
}

export function useAppInfo(): AppInfo | null {
  const [i, setI] = React.useState<AppInfo | null>(null)
  React.useEffect(() => { void ipc.appInfo().then(setI) }, [])
  return i
}

/** 1 Hz display clock. Only ever used to recompute from absolute epoch ms. */
export function useNowMs(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}
```

`@shared` alias: add `"@shared": resolve("src/shared")` to the renderer `resolve.alias` in `electron.vite.config.ts` and to `tsconfig.web.json` paths.

### 2.8 Enforcement: the renderer cannot reach the database

Three independent layers. All three are required; each catches what the others miss.

| Layer | Mechanism | Catches |
|---|---|---|
| Runtime | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | anything at all |
| Bridge | preload allowlist (§2.5) — a channel not in `INVOKE_CHANNELS` is rejected | a new handler wired without a contract entry |
| Lint | `no-restricted-imports` scoped to `src/renderer/**` | an import that would compile fine and only fail at runtime |

```jsonc
// eslint.config.js — the renderer override
{
  "files": ["src/renderer/**/*.{ts,tsx}"],
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        { "name": "electron", "message": "The renderer talks to main only through window.wwb." },
        { "name": "node:sqlite", "message": "The renderer never touches the database." },
        { "name": "node:fs", "message": "No filesystem in the renderer." },
        { "name": "node:path", "message": "No node builtins in the renderer." }
      ],
      "patterns": [
        { "group": ["**/main/**"], "message": "Renderer must not import from src/main." },
        { "group": ["**/core/**"], "message": "The reducer is main-side. Use IPC." }
      ]
    }]
  }
}
```

---

## 3. The tray

### 3.1 The title rule

**The title is "hours this week" (PRD D3), updated once a minute from MAIN while an interval is open, and frozen otherwise.**

Three sub-rules, each of which is a bug if you get it wrong:

1. **The tray number includes the open interval, credited to `lastSignalMs`, not to `now`.**
   The DB holds only closed intervals, so the tray would lag by hours without this. But crediting to `now` makes the number **shrink** by up to 15 minutes when the interval closes — a number that goes down is a support ticket. Crediting to `lastSignalMs` makes the tray show *exactly what the close rule will write*.
   The one exception: while `heldOpenBy` is non-null (camera/mic level), credit to `min(now, heldUntilMs)`, because camera-off will stamp that instant as the last signal.

2. **The open interval contributes nothing when it will not be countable.** If `jigglerOnForOpenInterval` and `countJigglerTime === 0`, add zero. Same filter as `v_countable`, applied to the row that does not exist yet.

3. **"Frozen" means the minute timer does not exist**, not that it ticks and no-ops. `setInterval` is created on interval-open and cleared on interval-close. While frozen, a **one-shot week-rollover timer** is armed instead — otherwise an idle Monday 00:00 leaves last week's total on the menu bar until the next keystroke.

Title format: `36.5h`, or `36.5h ⚠︎` when degraded, or `—h` before the first row exists. Always `tray.setTitle(text, { fontType: "monospacedDigit" })` — this is the menu bar's `tabular-nums`; without it the title jitters horizontally every minute.

### 3.2 The refresh table

| Refresh reason | Trigger | Timer state after |
|---|---|---|
| `boot` | after `runtime.start()` | armed iff an interval is open |
| `interval-open` | `RuntimeChange` | minute timer **armed**, rollover timer cleared |
| `interval-close` | `RuntimeChange` | minute timer **cleared**, rollover timer armed |
| `minute` | the 60 s interval | unchanged |
| `toggles` | jiggler / keep-awake / pause | unchanged (checkmarks + jiggler credit change) |
| `permissions` / `tap-health` | `RuntimeChange` | unchanged (icon + degraded item change) |
| `rows-pulled` | the other Mac's history landed | unchanged |
| `resume` | `powerMonitor` | re-armed from scratch |
| `unlock` | `powerMonitor` | unchanged |
| `week-rollover` | the one-shot timer | rollover timer re-armed for the next week |

`RuntimeChange === "signal"` is **ignored by the tray**. At 300 events/second a mouse drag would otherwise redraw the menu bar 300 times a second.

### 3.3 `src/shared/format.ts` — complete

Pure, dependency-free, unit-tested. Used by the tray (main) *and* the dashboard (renderer), which is the point: one implementation, so the two surfaces cannot disagree.

```ts
// src/shared/format.ts
import type { LiveStatus, MetricsPolicy } from "./ipc-types"

// ── calendar arithmetic (local, never UTC) ──────────────────────────────────

/** 'YYYY-MM-DD' in the LOCAL zone. Matches SQLite date('now','localtime'). */
export function localDateString(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  // NEVER new Date(ms).toISOString().slice(0,10) — that is UTC and silently
  // moves every evening interval to the next day. design/mock-data.reference.ts:28
  // does exactly this; do not carry it into the port.
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Monday 00:00 local. PRD §7: the week starts Monday. */
export function startOfIsoWeek(ms: number): number {
  const d = new Date(startOfLocalDay(ms))
  const dow = (d.getDay() + 6) % 7          // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow)
  d.setHours(0, 0, 0, 0)                    // re-normalise: setDate can cross a DST edge
  return d.getTime()
}

export function nextIsoWeekStart(ms: number): number {
  const d = new Date(startOfIsoWeek(ms))
  d.setDate(d.getDate() + 7)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** ISO-8601 week number, for the "week 34" line in the dashboard header. */
export function isoWeekNumber(ms: number): number {
  const d = new Date(startOfLocalDay(ms))
  d.setDate(d.getDate() + 4 - ((d.getDay() + 6) % 7 + 1))   // to the Thursday of this week
  const jan1 = new Date(d.getFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7)
}

// ── the one duration rule ───────────────────────────────────────────────────

/**
 * Credited length of the OPEN interval, in ms.
 *
 * THE RULE (AGENTS.md, PRD §3.2): an interval is worth time up to its last
 * real signal — never up to now(). The only exception is a camera/mic level
 * holding it open, where the eventual close stamp will be `now` (capped).
 *
 * This is the single function the tray and the status strip both call, so the
 * menu bar and the dashboard can never disagree about the current interval.
 */
export function creditedOpenMs(
  s: Pick<LiveStatus, "openedAtMs" | "lastSignalMs" | "heldOpenBy" | "heldUntilMs">,
  nowMs: number,
): number {
  if (s.openedAtMs === null) return 0
  const end =
    s.heldOpenBy === null
      ? s.lastSignalMs ?? s.openedAtMs
      : Math.min(nowMs, s.heldUntilMs ?? nowMs)
  return Math.max(0, end - s.openedAtMs)
}

/** Hours this week for the tray title and the "This week" stat card. */
export function hoursThisWeek(
  status: LiveStatus,
  policy: Pick<MetricsPolicy, "countJigglerTime" | "minIntervalS">,
  nowMs: number,
): number | null {
  const closed = status.closedHoursThisWeek
  const openMs = creditedOpenMs(status, nowMs)
  const openCounts =
    status.state === "working" &&
    openMs >= policy.minIntervalS * 1000 &&
    (policy.countJigglerTime === 1 || !status.jigglerOnForOpenInterval)
  const openH = openCounts ? openMs / 3_600_000 : 0
  if (closed === null) return openCounts ? round1(openH) : null
  return round1(closed + openH)
}

const round1 = (n: number) => Math.round(n * 10) / 10

// ── display formatters ──────────────────────────────────────────────────────

/** '36.5h' · '—h' when there is no data at all (never for a true zero). */
export function formatTrayTitle(hours: number | null, degraded: boolean): string {
  const n = hours === null ? "—" : hours.toFixed(1)
  return degraded ? `${n}h ⚠︎` : `${n}h`
}

/** '2h 41m' · '41m' · '0m'. Used for interval lengths and averages. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** '12s' · '4m' · '2h'. The ONLY formatter allowed to be relative to now(). */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

/** '36.5' · '—'. null means no data; 0 means zero hours. They differ. */
export function formatHours(h: number | null, digits = 1): string {
  return h === null ? "—" : h.toFixed(digits)
}

export function formatCount(n: number | null): string {
  return n === null ? "—" : n.toLocaleString()
}

/** '+4.2h vs last week' · '−1.1h vs last week' · null when there is no baseline. */
export function formatWeekDelta(thisWeek: number | null, lastWeek: number | null): string | null {
  if (thisWeek === null || lastWeek === null) return null
  const d = thisWeek - lastWeek
  const sign = d >= 0 ? "+" : "−"
  return `${sign}${Math.abs(d).toFixed(1)}h vs last week`
}

/** 'Wednesday, August 19 · week 34' — the dashboard subtitle. */
export function formatHeaderDate(ms: number): string {
  const d = new Date(ms)
  const long = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
  return `${long} · week ${isoWeekNumber(ms)}`
}
```

### 3.4 `src/main/tray.ts` — complete

```ts
// src/main/tray.ts
import { app, dialog, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron"
import { join } from "node:path"
import { settings } from "./settings"
import { showDashboard, showOnboarding } from "./windows"
import { openPrivacyPane } from "./permissions"
import { log } from "./log"
import type { AppRuntime, RuntimeChange } from "./runtime"
import {
  creditedOpenMs, formatAgo, formatDuration, formatHours, formatTrayTitle,
  hoursThisWeek, nextIsoWeekStart,
} from "../shared/format"
import type { DegradedReason, LiveStatus } from "../shared/ipc-types"

type RefreshReason =
  | "boot" | "interval-open" | "interval-close" | "minute" | "toggles"
  | "permissions" | "tap-health" | "rows-pulled" | "resume" | "unlock" | "week-rollover"

const ICON_DIR = app.isPackaged
  ? join(process.resourcesPath, "resources")
  : join(__dirname, "../../resources")

function icon(name: "trayTemplate" | "trayIdleTemplate" | "trayAlertTemplate") {
  const img = nativeImage.createFromPath(join(ICON_DIR, `${name}.png`))
  img.setTemplateImage(true)     // explicit: do not rely on the filename convention
  return img
}

const DEGRADED_COPY: Record<DegradedReason, { menu: string; fix: "onboarding" | "input" | "accessibility" | "none" }> = {
  keyboard_permission_missing: { menu: "Keyboard is not being tracked — fix…", fix: "input" },
  accessibility_missing:       { menu: "Jiggler needs Accessibility — fix…",   fix: "accessibility" },
  relaunch_required:           { menu: "Restart to finish granting access…",   fix: "onboarding" },
  tap_lost:                    { menu: "Input tap was lost — see Doctor…",     fix: "none" },
  sync_silent_72h:             { menu: "No cloud write in 72 h — see Doctor…", fix: "none" },
  fingerprint_mismatch:        { menu: "Cloud fingerprint mismatch — Doctor…", fix: "none" },
  db_unwritable:               { menu: "Local database is not writable…",      fix: "none" },
}

export class TrayController {
  private readonly tray: Tray
  private minuteTimer: NodeJS.Timeout | null = null
  private rolloverTimer: NodeJS.Timeout | null = null

  constructor(private readonly runtime: AppRuntime) {
    this.tray = new Tray(icon("trayIdleTemplate"))
    this.tray.setIgnoreDoubleClickEvents(true)
    // Build the menu on every open so the numbers are fresh. setContextMenu()
    // would snapshot them at construction time.
    this.tray.on("click", () => this.popUp())
    this.tray.on("right-click", () => this.popUp())
  }

  onRuntimeChange(kind: RuntimeChange): void {
    if (kind === "signal") return           // 300/s during a drag. Never redraw on this.
    this.refresh(kind === "interval-open" ? "interval-open"
      : kind === "interval-close" ? "interval-close"
      : kind === "toggles" ? "toggles"
      : kind === "permissions" ? "permissions"
      : kind === "tap-health" ? "tap-health"
      : kind === "rows-pulled" ? "rows-pulled"
      : "boot")
  }

  refresh(reason: RefreshReason): void {
    let status: LiveStatus
    try {
      status = this.runtime.liveStatus()
    } catch (err) {
      log.error("liveStatus() threw during tray refresh", err)
      return                                // never let the tray take the app down
    }

    const policy = settings.all()
    const hours = hoursThisWeek(status, policy, Date.now())
    const degraded = status.degraded.length > 0

    this.tray.setTitle(formatTrayTitle(hours, degraded), { fontType: "monospacedDigit" })
    this.tray.setImage(
      degraded ? icon("trayAlertTemplate")
      : status.state === "working" ? icon("trayTemplate")
      : icon("trayIdleTemplate"),
    )
    this.tray.setToolTip(
      degraded
        ? `Work Week Buddy — ${DEGRADED_COPY[status.degraded[0]].menu}`
        : `Work Week Buddy — ${formatHours(hours)}h this week`,
    )

    this.armTimers(status, reason)
  }

  /**
   * The minute timer exists ONLY while an interval is open. While it is frozen,
   * a one-shot week-rollover timer keeps Monday 00:00 honest.
   */
  private armTimers(status: LiveStatus, reason: RefreshReason): void {
    const open = status.state === "working"

    if (open && this.minuteTimer === null) {
      this.minuteTimer = setInterval(() => this.refresh("minute"), 60_000)
      this.clearRollover()
    }
    if (!open && this.minuteTimer !== null) {
      clearInterval(this.minuteTimer)
      this.minuteTimer = null
    }
    if (!open && this.rolloverTimer === null) this.armRollover()
    if (reason === "week-rollover") { this.clearRollover(); if (!open) this.armRollover() }
    if (reason === "resume") {
      // A timer that slept through the boundary is not to be trusted.
      this.clearRollover()
      if (!open) this.armRollover()
    }
  }

  private armRollover(): void {
    const delay = Math.max(1000, nextIsoWeekStart(Date.now()) - Date.now())
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = null
      this.refresh("week-rollover")
    }, delay)                               // ≤ 7 days; no 32-bit overflow risk
  }

  private clearRollover(): void {
    if (this.rolloverTimer) { clearTimeout(this.rolloverTimer); this.rolloverTimer = null }
  }

  private popUp(): void {
    this.tray.popUpContextMenu(Menu.buildFromTemplate(this.template()))
  }

  private template(): MenuItemConstructorOptions[] {
    const s = this.runtime.liveStatus()
    const t = this.runtime.toggles()
    const now = Date.now()
    const policy = settings.all()

    const items: MenuItemConstructorOptions[] = []

    // ── degraded first. Loud, at the top, enabled, with a fix. PRD §3.7 ──────
    for (const reason of s.degraded) {
      const copy = DEGRADED_COPY[reason]
      items.push({
        label: `⚠︎  ${copy.menu}`,
        click: () => {
          if (copy.fix === "input") openPrivacyPane("inputMonitoring")
          else if (copy.fix === "accessibility") openPrivacyPane("accessibility")
          else if (copy.fix === "onboarding") void showOnboarding()
          else void showDashboard()
        },
      })
    }
    if (s.degraded.length) items.push({ type: "separator" })

    // ── current interval ────────────────────────────────────────────────────
    const openMs = creditedOpenMs(s, now)
    items.push({
      label:
        s.state === "paused" ? "Paused"
        : s.state === "working" ? `Working · ${formatDuration(openMs)}`
        : "Idle",
      enabled: false,
    })
    items.push({
      label: s.lastSignalMs === null
        ? "no signal yet"
        : `last signal ${formatAgo(now - s.lastSignalMs)} ago${s.lastSignalKind === "camera" ? " · camera" : s.lastSignalKind === "mic" ? " · meeting mic" : ""}`,
      enabled: false,
    })
    items.push({ type: "separator" })

    items.push({ label: `Today          ${formatHours(s.closedHoursToday)}h`, enabled: false })
    items.push({ label: `This week      ${formatHours(hoursThisWeek(s, policy, now))}h`, enabled: false })
    items.push({ label: `Machine        ${s.machineLabel || s.machineId.slice(0, 8)}`, enabled: false })
    items.push({ type: "separator" })

    // ── the three toggles ───────────────────────────────────────────────────
    items.push({
      // A toggle that appears on but does nothing is the failure mode to design
      // against (MACOS.md §6). Without Accessibility the switch is DISABLED and
      // says why — it is never merely unchecked.
      label: t.jigglerAvailable ? "Jiggler" : `Jiggler — ${t.jigglerUnavailableReason}`,
      type: "checkbox",
      checked: t.jiggler,
      enabled: t.jigglerAvailable,
      click: () => { void this.onJigglerToggled(!t.jiggler) },
    })
    items.push({
      label: "Keep awake",
      type: "checkbox",
      checked: t.keepAwake,
      click: () => { void this.runtime.setToggle({ key: "keepAwake", value: !t.keepAwake, source: "tray" }) },
    })
    items.push({
      label: "Pause tracking",
      type: "checkbox",
      checked: t.paused,
      click: () => { void this.runtime.setToggle({ key: "paused", value: !t.paused, source: "tray" }) },
    })
    items.push({ type: "separator" })

    items.push({ label: "Open Dashboard…", click: () => void showDashboard() })
    items.push({
      label: "Sync now",
      click: () => {
        void this.runtime.flushNow().then((r) => {
          if (!r.ok) dialog.showErrorBox("Sync failed", r.error ?? "unknown error")
        })
      },
    })
    items.push({ label: "Doctor…", click: () => void showDashboard() })
    items.push({ type: "separator" })
    items.push({ label: "Quit Work Week Buddy", role: "quit" })

    return items
  }

  /**
   * Toggling the jiggler is an INTERVAL BOUNDARY (PRD §6 D1, AGENTS.md).
   * setToggle() resolves only after the boundary is committed and the successor
   * interval is open, so refresh() below reads a consistent state.
   */
  private async onJigglerToggled(next: boolean): Promise<void> {
    await this.runtime.setToggle({ key: "jiggler", value: next, source: "tray" })
    this.refresh("toggles")
    if (next) await this.offerPause()
  }

  /** The "…and pause tracking?" affordance. */
  private async offerPause(): Promise<void> {
    if (settings.get("jigglerPausePrompt") === "never") return
    if (this.runtime.toggles().paused) return

    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Keep tracking", "Also pause tracking"],
      defaultId: 0,
      cancelId: 0,
      message: "Jiggler on — this time will not count as work.",
      detail:
        "Intervals recorded while the jiggler runs are still stored, but they are " +
        "excluded from your hours. Tracking keeps running so that choice stays " +
        "reversible later.\n\nPause tracking as well?",
      checkboxLabel: "Don’t ask again",
      checkboxChecked: false,
    })

    if (checkboxChecked) await settings.set("jigglerPausePrompt", "never")
    if (response === 1) {
      await this.runtime.setToggle({ key: "paused", value: true, source: "tray" })
      this.refresh("toggles")
    }
  }

  destroy(): void {
    if (this.minuteTimer) clearInterval(this.minuteTimer)
    this.clearRollover()
    this.tray.destroy()
  }
}
```

### 3.5 Jiggler toggle — the interval boundary, precisely

This is the rule that keeps `jiggler_s` homogeneous, which is what makes `v_countable`'s filter composable with the cross-machine union merge.

| State when the jiggler is toggled | What happens |
|---|---|
| An interval is **open** | Close it at `lastSignalMs` with `end_reason = 'jiggler_boundary'`, then immediately open a successor at that same timestamp with the new jiggler state. |
| Interval is **held open** by camera or mic | Same, closing at `min(now, heldUntilMs)` — the hold's own close stamp. |
| **Idle** | Nothing. There is no boundary to draw. The next interval simply opens with the new jiggler state. |
| **Paused** | Nothing. Pausing already closed the interval. |

**The `end_reason` for a jiggler boundary.** `docs/DATA_MODEL.md` enumerates `idle_timeout | sleep | lock | shutdown | app_quit | paused | crash_recovered | tap_lost`. A jiggler boundary is none of these, and mislabelling it makes the soak-test `tap_lost`/`crash_recovered` counts lie.

> **Contract for `docs/IMPL_DATA.md`:** add `jiggler_boundary` to the `end_reason` enum. It is a free-text `TEXT NOT NULL` column with no CHECK constraint, so this needs no migration — only that both the local mirror and the Worker accept it, and that the doctor panel's counters exclude it.

The successor interval opens at the **same timestamp** the predecessor closed at, so no wall-clock time is lost at the seam. `duration_s` of the closed row and `started_at_ms` of the new row are contiguous.

**Invariant to assert in the reducer test (M2 gate (e)):** for every stored row, `jiggler_s === 0 || jiggler_s === duration_s`.

### 3.6 Icons

Three template PNGs in `resources/`, each shipped at `@1x` (16×16) and `@2x` (32×32):

| File | State | Shape |
|---|---|---|
| `trayTemplate.png` | working | filled dot |
| `trayIdleTemplate.png` | idle / paused | hollow ring |
| `trayAlertTemplate.png` | any `degraded` reason | ring with an exclamation |

All three are **template images**: pure black + alpha only. macOS recolours them for light/dark menu bars and for the highlighted state. Colour in a template image is discarded, so a red "alert" icon is not available — the alert is carried by the shape, the `⚠︎` in the title, and the menu item.

---

## 4. Permission onboarding

Two permissions, two panes, one window. They are **independent TCC rows** — having one does not imply the other (`docs/MACOS.md` §6).

| Pane | TCC service | Settings pane | Preflight | Request | If denied |
|---|---|---|---|---|---|
| 1. Input Monitoring | `kTCCServiceListenEvent` | Privacy → Input Monitoring | `CGPreflightListenEventAccess()`, `IOHIDCheckAccess(1)` | `CGRequestListenEventAccess()` | **Keyboard silently untracked.** Loud banner, hours run low forever otherwise. Mouse + camera keep working. |
| 2. Accessibility | `kTCCServicePostEvent` | Privacy → Accessibility | `CGPreflightPostEventAccess()`, `AXIsProcessTrusted()` | `AXIsProcessTrustedWithOptions({prompt:true})` | Jiggler disabled with a reason. **Tracking unaffected.** |

Neither the camera nor the microphone gets a pane. Both were verified to need no permission — and if the mic ever *does* prompt, that is a defect, reported as `PermissionSnapshot.microphone === "prompted"` and shown in the doctor panel (M1 gate (g)).

### 4.1 The sequence — preflight, then request, then poll

```
preflight() ──true──▶ done, no UI at all
     │
    false
     ▼
request()  ← the system prompt appears AT MOST ONCE PER APP IDENTITY, EVER
     │
     ├─ returns true  ──▶ re-read the granted mask; done
     └─ returns false ──▶ poll preflight() at 1 Hz for up to 45 s
                             │
                             ├─ flips true ──▶ re-read the granted mask
                             └─ still false after 8 s ──▶ reveal "Open System Settings…"
```

Three things that are easy to get wrong:

1. **The prompt is one-shot for the lifetime of the app identity.** After the first `CGRequestListenEventAccess()`, subsequent calls return `false` immediately with no dialog. The only remaining path is System Settings. That is why "Open System Settings…" appears after 8 seconds rather than being the first thing shown — showing it first trains the user to skip the prompt, and skipping the prompt means the app never appears in the list.
2. **Poll in MAIN, not in the renderer.** The onboarding window is behind System Settings the entire time the user is granting. `AGENTS.md` trap #10: a hidden renderer's timers collapse. Main polls; main pushes `wwb:push:permissions`.
3. **This poll is not a violation of NON_GOALS #1.** That rule is about polling for *input*. A 1 Hz TCC read, alive only while an onboarding window exists, with a hard 45 s stop, is UI plumbing. Document it inline so nobody deletes it as a rules violation.

### 4.2 `src/main/permissions.ts` — complete

```ts
// src/main/permissions.ts
import { shell } from "electron"
import { native } from "./native"                // docs/IMPL_NATIVE.md
import { getOnboardingWindow } from "./windows"
import type { PermissionKey, PermissionSnapshot, PermissionState } from "../shared/ipc-types"
// NOTE: this module must NOT import from ./ipc. ipc.ts imports openPrivacyPane
// from here, and the cycle resolves to `undefined` at module-init time under
// CJS. The poll takes a callback instead; index.ts does the pushing.

const PANE_URL: Record<PermissionKey, string> = {
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  accessibility:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

export function openPrivacyPane(which: PermissionKey): void {
  void shell.openExternal(PANE_URL[which])
}

/**
 * The interface `src/main/native.ts` must expose. Contract for docs/IMPL_NATIVE.md.
 * IOHIDCheckAccess: 0 = granted, 1 = denied, 2 = unknown/undetermined.
 */
export interface NativePermissionApi {
  preflightListenEvent(): boolean
  requestListenEvent(): boolean
  ioHidCheckAccess(): 0 | 1 | 2
  preflightPostEvent(): boolean
  requestPostEvent(): boolean
  axIsProcessTrusted(): boolean
  axPromptForTrust(): boolean
  /** Reads the LIVE tap's granted mask via CGGetEventTapList. The authority. */
  grantedMask(): number
}

const KEY_BITS = (1 << 10) | (1 << 11)     // keyDown | keyUp
const FLAGS_BIT = 1 << 12                  // flagsChanged — modifier-only presses

let promptConsumed: Record<PermissionKey, boolean> = {
  inputMonitoring: false,
  accessibility: false,
}

export function readPermissions(): PermissionSnapshot {
  const preInput = native.preflightListenEvent()
  const hid = native.ioHidCheckAccess()
  const preAx = native.preflightPostEvent()
  const axTrusted = native.axIsProcessTrusted()
  const mask = native.grantedMask()

  const keyboardBitsGranted = (mask & KEY_BITS) === KEY_BITS
  const flagsChangedBitGranted = (mask & FLAGS_BIT) === FLAGS_BIT

  const inputMonitoring: PermissionState =
    preInput || hid === 0 ? "granted" : hid === 1 ? "denied" : "undetermined"
  const accessibility: PermissionState =
    preAx && axTrusted ? "granted" : promptConsumed.accessibility ? "denied" : "undetermined"

  return {
    checkedAtMs: Date.now(),
    inputMonitoring,
    accessibility,
    // MACOS.md §6: which bucket governs the keyboard bits is genuinely disputed,
    // so the mask — not either preflight — decides.
    keyboardBitsGranted,
    flagsChangedBitGranted,
    relaunchRequired: inputMonitoring === "granted" && !keyboardBitsGranted,
    promptConsumed: { ...promptConsumed },
    microphone: "not-required",       // overwritten by the runtime if a prompt is ever observed
  }
}

/** preflight → request. Never prompts twice; the OS would ignore it anyway. */
export function requestPermission(which: PermissionKey): PermissionSnapshot {
  if (which === "inputMonitoring") {
    if (!native.preflightListenEvent()) {
      native.requestListenEvent()
      promptConsumed.inputMonitoring = true
    }
  } else {
    if (!native.preflightPostEvent() || !native.axIsProcessTrusted()) {
      native.requestPostEvent()
      native.axPromptForTrust()
      promptConsumed.accessibility = true
    }
  }
  return readPermissions()
}

// ── the 1 Hz poll, alive only while onboarding is open ──────────────────────
// NOT a NON_GOALS #1 violation: that rule bans polling for INPUT. This is a TCC
// read, scoped to an open window, with a hard stop. It lives in MAIN because a
// backgrounded renderer's timers collapse (AGENTS.md trap #10) and this window
// spends its whole life behind System Settings.
let pollTimer: NodeJS.Timeout | null = null
let pollDeadlineMs = 0

export function startPermissionPoll(onChange: (s: PermissionSnapshot) => void): void {
  pollDeadlineMs = Date.now() + 45_000
  if (pollTimer) return
  let last = JSON.stringify(readPermissions())
  pollTimer = setInterval(() => {
    if (!getOnboardingWindow() || Date.now() > pollDeadlineMs) return stopPermissionPoll()
    const snap = readPermissions()
    const json = JSON.stringify({ ...snap, checkedAtMs: 0 })
    if (json !== last) {
      last = json
      onChange(snap)          // index.ts wires this to pushAll('wwb:push:permissions')
    }
  }, 1000)
}

export function stopPermissionPoll(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
```

### 4.3 The relaunch rule

A fresh **Input Monitoring** grant does not retroactively add the keyboard bits to a tap that already exists. macOS's own dialog says "quit and reopen" for a reason.

**The decider is the mask, not the grant.** After the grant is observed:

1. Ask the runtime to recreate the tap.
2. Re-read `grantedMask()`.
3. If the keyboard bits are present → done, no restart, no UI.
4. If they are still missing → set `relaunchRequired: true`, and show a **Restart now** button.

`wwb:permissions:relaunch` closes the open interval with `end_reason: 'app_quit'` **before** relaunching. Relaunching without that loses up to 15 minutes to crash recovery for no reason.

```ts
// inside src/main/ipc.ts (already shown in §2.6)
handle("wwb:permissions:relaunch", async () => {
  await runtime.stop("app_quit")          // close + flush first
  app.relaunch({ args: process.argv.slice(1) })
  app.exit(0)
  return undefined as never
})
```

Accessibility, by contrast, flips live: `AXIsProcessTrusted()` starts returning true and `CGEventPost` starts working without a restart. Do not offer a restart for it.

### 4.4 `src/renderer/src/Onboarding.tsx`

```tsx
// src/renderer/src/Onboarding.tsx
import * as React from "react"
import { Check, KeyRound, MousePointer2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ipc, usePermissions } from "@/lib/ipc"
import type { PermissionKey, PermissionSnapshot } from "@shared/ipc-types"

type PaneId = PermissionKey

const PANES: Array<{
  id: PaneId
  title: string
  why: string
  ifDenied: string
  icon: React.ReactNode
  granted: (p: PermissionSnapshot) => boolean
}> = [
  {
    id: "inputMonitoring",
    title: "Input Monitoring",
    why: "Lets the app see that a key was pressed. It never sees which key, never sees text, and never records anything you type.",
    ifDenied: "Without it, typing is invisible and your hours come out low — quietly. Mouse and camera keep working.",
    icon: <KeyRound className="size-5" />,
    granted: (p) => p.keyboardBitsGranted,
  },
  {
    id: "accessibility",
    title: "Accessibility",
    why: "Only used by the optional mouse jiggler, which posts an event that carries no coordinates and cannot move your cursor.",
    ifDenied: "The jiggler stays switched off. Tracking is completely unaffected.",
    icon: <MousePointer2 className="size-5" />,
    granted: (p) => p.accessibility === "granted",
  },
]

export function Onboarding() {
  const perms = usePermissions()
  const [step, setStep] = React.useState(0)
  const [requested, setRequested] = React.useState<Record<string, number>>({})

  const pane = PANES[step]
  const granted = perms ? pane.granted(perms) : false
  // The System Settings escape hatch appears 8 s after the request, not before:
  // offering it first trains you to dismiss the prompt, and a dismissed prompt
  // means the app never appears in the list at all.
  const showSettingsLink =
    !!requested[pane.id] && Date.now() - requested[pane.id] > 8000 && !granted

  const request = async () => {
    setRequested((r) => ({ ...r, [pane.id]: Date.now() }))
    await ipc.requestPermission(pane.id)
  }

  return (
    <div className="flex min-h-svh flex-col bg-background px-8 pt-12 pb-8">
      <div className="flex gap-1.5">
        {PANES.map((p, i) => (
          <div key={p.id}
            className={`h-1 flex-1 rounded-full ${i <= step ? "bg-foreground" : "bg-muted"}`} />
        ))}
      </div>

      <div className="mt-8 flex-1">
        <div className="flex items-center gap-2 text-muted-foreground">{pane.icon}
          <span className="text-[11px] font-medium tracking-[0.06em] uppercase">
            step {step + 1} of {PANES.length}
          </span>
        </div>
        <h1 className="font-heading mt-3 text-[22px] leading-tight font-semibold tracking-tight">
          {pane.title}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{pane.why}</p>
        <p className="mt-3 text-sm text-muted-foreground">{pane.ifDenied}</p>

        {granted ? (
          <div className="mt-6 flex items-center gap-2 text-sm font-medium">
            <Check className="size-4" /> Granted
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            <Button onClick={request}>Grant {pane.title}</Button>
            {showSettingsLink && (
              <Button variant="ghost" onClick={() => void ipc.openPrivacyPane(pane.id)}>
                Open System Settings…
              </Button>
            )}
          </div>
        )}

        {perms?.relaunchRequired && pane.id === "inputMonitoring" && (
          <div className="border-destructive/40 bg-destructive/10 mt-6 rounded-lg border p-3">
            <p className="text-sm">
              The grant landed, but the running app still has no keyboard access.
              macOS needs a restart to apply it.
            </p>
            <Button className="mt-3" onClick={() => void ipc.relaunch()}>
              <RotateCw className="size-3.5" /> Restart now
            </Button>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
          Back
        </Button>
        {step < PANES.length - 1 ? (
          <Button variant="ghost" onClick={() => setStep((s) => s + 1)}>Next</Button>
        ) : (
          <Button onClick={() => void ipc.dismissOnboarding()}>Done</Button>
        )}
      </div>
    </div>
  )
}
```

"Done" sets `onboardingDismissed` and closes the window. It does **not** clear a degraded state: if Input Monitoring is still missing, the banner and the tray warning stay, forever, until it is fixed. Dismissing onboarding is not consent to bad data.

### 4.5 The degraded state — loud in four places at once

`LiveStatus.degraded` is recomputed on every permission read, every tap-health change, every flush and every fingerprint check. When it is non-empty:

| Surface | What changes |
|---|---|
| Tray icon | `trayAlertTemplate` |
| Tray title | `36.5h ⚠︎` |
| Tray menu | a **clickable** item at the very top, above everything, with a fix action |
| Dashboard | a `DegradedBanner` between the header and the live-status strip, non-dismissible |
| Doctor panel | the offending row, red, with the underlying value |

**The rule the banner exists to enforce:** a metric that is wrong because of a missing permission may never render as a bare number. When `keyboard_permission_missing` is present, the "This week" card also renders a `⚠︎` next to its value. A user glancing at the menu bar must not be able to read a low number as good news.

```tsx
// src/renderer/src/DegradedBanner.tsx
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ipc } from "@/lib/ipc"
import type { DegradedReason } from "@shared/ipc-types"

const COPY: Record<DegradedReason, { title: string; detail: string; action?: { label: string; run: () => void } }> = {
  keyboard_permission_missing: {
    title: "Keyboard is not being tracked",
    detail: "Input Monitoring is off, so typing is invisible and your hours are running low. Mouse and camera are still counted.",
    action: { label: "Fix in System Settings", run: () => void ipc.openPrivacyPane("inputMonitoring") },
  },
  relaunch_required: {
    title: "Restart to finish granting access",
    detail: "The permission was granted, but macOS applies it only to a freshly launched app.",
    action: { label: "Restart now", run: () => void ipc.relaunch() },
  },
  accessibility_missing: {
    title: "Jiggler is unavailable",
    detail: "Accessibility is off. Tracking is unaffected.",
    action: { label: "Fix in System Settings", run: () => void ipc.openPrivacyPane("accessibility") },
  },
  tap_lost: {
    title: "The input tap was lost and recreated",
    detail: "macOS disabled the event tap. Intervals around that time may be short. See Doctor for the count.",
  },
  sync_silent_72h: {
    title: "No cloud write in over 72 hours",
    detail: "Your local history is safe; the upload path is not working.",
    action: { label: "Sync now", run: () => void ipc.flush() },
  },
  fingerprint_mismatch: {
    title: "Cloud and local history disagree",
    detail: "The weekly fingerprint check failed. See Doctor for both counts.",
  },
  db_unwritable: {
    title: "The local database is not writable",
    detail: "Nothing is being recorded right now.",
  },
}

export function DegradedBanner({ reasons }: { reasons: DegradedReason[] }) {
  if (reasons.length === 0) return null
  return (
    <div className="mt-4 flex flex-col gap-2">
      {reasons.map((r) => {
        const c = COPY[r]
        return (
          <div key={r}
            className="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border px-4 py-3">
            <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium">{c.title}</div>
              <div className="text-muted-foreground mt-0.5 text-xs">{c.detail}</div>
            </div>
            {c.action && (
              <Button size="sm" variant="outline" onClick={c.action.run}>{c.action.label}</Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

**Revocation, not just first run.** A permission removed in System Settings while the app runs must produce the same banner within one watchdog tick. The 5-minute read-only watchdog already re-reads the granted mask; wire its result into `degraded`. That is M5 gate (c), and it is why the mask read is in the watchdog rather than only at boot.

---

## 5. The dashboard

`design/App.reference.tsx` is the **visual acceptance target**, not a sketch. The port is a data swap plus seven small fixes. Everything not listed in §5.6 stays byte-identical.

### 5.1 Copy verbatim, do not rewrite

| From | To | Note |
|---|---|---|
| `design/index.css` | `src/renderer/src/index.css` | Byte-for-byte. `shadcn init --force` silently reverts the `:root` / `.dark` blocks — that is why the file is in the repo. |
| `design/theme-provider.reference.tsx` | `src/renderer/src/components/theme-provider.tsx` | Verbatim. **Do not add a `resolvedTheme` field to it** — §5.2 gets that without touching the file. |
| `design/App.reference.tsx` | `src/renderer/src/App.tsx` | Ported per §5.6. |

`design/mock-data.reference.ts` is **not** copied. It is a shape reference for what the queries must return, and it contains a UTC date bug (§0.1 rule 8) that must not travel.

### 5.2 The three required fixes

**Fix 1 — the tooltips stylesheet.** Without it, `react-activity-calendar`'s tooltips render as unstyled text blocks floating at the top-left of the page. No error.

```tsx
// src/renderer/src/App.tsx — line 2, immediately after the ActivityCalendar import
import { ActivityCalendar, type Activity } from "react-activity-calendar"
import "react-activity-calendar/tooltips.css"
```

**Fix 2 — explicit `colorScheme`.** The component reads `prefers-color-scheme`; the app follows a `.dark` class on `<html>`. Press `d` to force light mode while macOS is dark and the heatmap alone stays dark.

`useTheme()` from the reference provider returns `{ theme, setTheme }`, where `theme` can be `"system"` — not what `colorScheme` needs. Rather than edit a file marked *copy verbatim*, read the class the provider already writes. It is the single source of truth and it is always correct by construction.

```ts
// src/renderer/src/lib/use-resolved-theme.ts
import * as React from "react"

const subscribe = (cb: () => void) => {
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => obs.disconnect()
}

const getSnapshot = (): "light" | "dark" =>
  document.documentElement.classList.contains("dark") ? "dark" : "light"

/**
 * The resolved theme, read off the class ThemeProvider writes to <html>.
 * Exists so ActivityCalendar can be given colorScheme explicitly without
 * modifying design/theme-provider.reference.tsx, which is copied verbatim.
 */
export function useResolvedTheme(): "light" | "dark" {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
```

```tsx
// inside App(), and on the <ActivityCalendar> element:
const resolvedTheme = useResolvedTheme()
…
<ActivityCalendar
  colorScheme={resolvedTheme}       // ← the fix
  data={activities}
  …
/>
```

**Fix 3 — the `app://` protocol.** Vite emits ESM; Electron cannot load ESM over `file://`. Fully specified in §1.4. The renderer-side consequence is one line in `index.html`: every asset reference must be **relative**, so `vite.config` needs `base: "./"` — an absolute `/assets/…` resolves to `app://wwb/assets/…` only by luck of the host, and breaks the moment the host changes.

```ts
// electron.vite.config.ts → renderer
renderer: {
  root: "src/renderer",
  base: "./",                     // ← relative asset URLs under app://
  resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
  plugins: [react()],
}
```

### 5.3 The CSP

Set once, in the protocol handler (§1.4). Repeated here because it is the thing most likely to be "cleaned up":

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'self';
media-src 'none'; object-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'
```

| Directive | Who needs it |
|---|---|
| `style-src 'unsafe-inline'` | **Recharts** writes an inline `style` attribute on every `<path>`, `<g>` and `<rect>` it draws. **@floating-ui** (shadcn `DropdownMenu`, `ChartTooltip`, and `react-activity-calendar`'s tooltips) positions every floating element with an inline `transform`. Both are `style-src-attr`, which a bare `style-src 'unsafe-inline'` covers. Without it, the chart renders as invisible black-on-black paths and every dropdown appears at `(0,0)`. |
| `font-src 'self'` | `@fontsource-variable/inter`, imported by `index.css`, emits woff2 files fetched over `app://`. |
| `img-src data:` | shadcn/lucide inline SVG data URIs. |
| `script-src 'self'` — **not** `'unsafe-inline'` | The FOUC killer is a real file (§5.5), not an inline `<script>`. Keeping script-src tight is the whole point of having a CSP in a page that renders your own data. |
| `connect-src 'self'` | The renderer never talks to the network. The Worker is main's job. |

**Do not add a `<meta http-equiv="Content-Security-Policy">` as well.** Two policies intersect. The day someone edits one and not the other, Recharts stops drawing and the console message is not the one you would search for.

### 5.4 `minWidth: 880`, and the arithmetic behind it

The 53-week heatmap is ~745 px and **does not shrink** — `react-activity-calendar` renders fixed-size blocks (`blockSize={11}`, `blockMargin={3}` → 14 px per week column × 53 + weekday labels).

```
window width                    880
  − page px-8 (32 × 2)          −64   →  816   content width
  − card px-5 (20 × 2)          −40   →  776   inner card width
  vs. the calendar               745
                                 ───
  headroom                        31 px
```

880 is therefore the smallest width at which the heatmap does not scroll. Below it, `overflow-x-auto` (already on line 206 of the reference) takes over and the page body still never scrolls horizontally. Both are required: `minWidth` for the common case, the wrapper for the safety case.

### 5.5 The FOUC killer

An inline `<script>` in `<head>` would need `script-src 'unsafe-inline'` or a build-time hash. Neither is worth it. Use a **classic (non-module) script from `public/`**: a classic `<script src>` in `<head>` blocks parsing and runs before the first paint, while Vite's module bundle is deferred and runs far too late.

```js
// src/renderer/public/theme-boot.js
// Stamps the theme class on <html> BEFORE React mounts, so the app never
// flashes the wrong background on launch. Kept as a real file (not inline) so
// the CSP can stay script-src 'self'.
// The storage key MUST match ThemeProvider's default storageKey ('theme').
;(function () {
  try {
    var stored = localStorage.getItem("theme")
    var t =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
    document.documentElement.classList.add(t)
    document.documentElement.style.colorScheme = t   // native scrollbars, form controls
  } catch (e) {
    document.documentElement.classList.add("light")
  }
})()
```

```html
<!-- src/renderer/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Work Week Buddy</title>
    <!-- Classic, synchronous, before anything paints. Not type="module". -->
    <script src="./theme-boot.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

Second half of the same fix: the **window's own background** is painted by Chromium before the renderer's first frame. `BrowserWindow` gets `backgroundColor` from main-side settings (§1.5), and the renderer mirrors its resolved theme back so the *next* launch is right:

```tsx
// src/renderer/src/lib/use-theme-mirror.ts
import * as React from "react"
import { ipc } from "./ipc"
import { useResolvedTheme } from "./use-resolved-theme"

/** Tells main what to paint behind the next window. Main cannot read localStorage. */
export function useThemeMirror(): void {
  const resolved = useResolvedTheme()
  React.useEffect(() => {
    void ipc.setSettings({ windowBackground: resolved === "dark" ? "#191919" : "#FFFFFF" })
  }, [resolved])
}
```

Those two hex values are `--background` from `design/index.css` (`:root` and `.dark`). If the palette changes, change them here too — there is no way to read a CSS variable from main.

### 5.6 `App.reference.tsx` → `App.tsx`: every change

Line numbers refer to `design/App.reference.tsx` as committed.

| Lines | Change | Why |
|---|---|---|
| 2 | **Add** `import "react-activity-calendar/tooltips.css"` | Fix 1 |
| 30 | **Delete** `import { makeMockDays, MACHINES } from "@/data"` | no mock data ships |
| 30 | **Add** the IPC imports (§5.7) | |
| 32 | **Delete** `const days = makeMockDays()` | |
| 34–40 | **Delete** `levelFor()` | the level is computed in SQL (query 4) and is a policy knob, not renderer arithmetic |
| 42–46 | **Delete** `const activities` | comes from `metrics.heatmap`, already `{date, count, level}` |
| 48–56 | **Delete** `const weekBars` | comes from `metrics.weekBars` |
| 58–60 | **Keep** `chartConfig` verbatim | |
| 62–72 | **Change** `StatCard` props: `value: string` → `value: string \| null`, add `warn?: boolean` | PRD §4 empty state: every card renders at full size with `—` |
| 79–81 | **Change** the value span to render `—` when `value === null`, and append a `⚠︎` when `warn` | §4.5 — a wrong number never renders bare |
| 93–116 | **Keep** `ThemeToggle` verbatim | |
| 118–120 | **Replace** both `useState` calls with `useToggles()` | the jiggler is off by default and lives in main; `useState(true)` in the reference is a mockup convenience, not the product |
| 122–124 | **Keep** the outer layout verbatim | |
| 126 | **Add** `className="… [-webkit-app-region:drag]"` to `<header>` | `titleBarStyle: "hiddenInset"` leaves no draggable chrome |
| 129 | **Change** `Work Week Tracker` → `Work Week Buddy` | the reference title is stale |
| 132 | **Replace** the hardcoded date with `formatHeaderDate(nowMs)` | |
| 135–137 | **Add** `[-webkit-app-region:no-drag]` to the button container; **add** a `Doctor` toggle button beside `ThemeToggle` | a drag region swallows clicks |
| — | **Insert** `<DegradedBanner reasons={status.degraded} />` between `</header>` and the live-status `<section>` | §4.5 |
| 142–145 | **Wrap** the ping animation in `status.state === "working"` | a pulsing dot while idle is a lie |
| 146 | `"Working"` → `status.state` label (`Working` / `Idle` / `Paused`) | |
| 148 | `"2h 41m"` → `formatDuration(creditedOpenMs(status, nowMs))` | §3.1 rule 1 |
| 153 | `"Work laptop"` → `status.machineLabel` | |
| 157 | `"12s"` → `formatAgo(nowMs − status.lastSignalMs)` | the only `now`-relative field |
| 160–164 | Jiggler `<Switch>` → `toggles.jiggler`; **add** `disabled={!toggles.jigglerAvailable}` and a `title` with the reason | MACOS.md §6: never a switch that appears on and does nothing |
| 165–169 | `Caffeinate` → **`Keep awake`**, `caffeinate` state → `toggles.keepAwake` | the menu bar, the PRD and `pmset` all say keep-awake; `caffeinate` is a *banned implementation* (MACOS.md §5). Two names for one toggle is a bug factory. This is the only intentional copy divergence from the mockup. |
| 175–195 | All four `StatCard`s → `metrics` fields (§5.7) | |
| 203 | `"2,614 h tracked since Aug 2025"` → `metrics.allTime.hoursTracked` + `sinceDate` | |
| 207–227 | `data={activities}` → `data={metrics.heatmap}`; **add** `colorScheme={resolvedTheme}` | Fix 2 |
| 217–220 | **Keep the 5-stop theme arrays verbatim** | a 2-stop ramp renders a full-time year as an unreadable block |
| 221 | **Keep** `labels={{ legend: { less: "0h", more: "8h+" } }}` | matches the level thresholds in §5.8 |
| 224 | Tooltip text → `` `${a.count.toFixed(1)} h on ${a.date}` `` | SQL returns 2 dp; the mockup shows 1 |
| 239 | `data={weekBars}` → `data={metrics.weekBars}` | |
| 265–283 | `MACHINES.map` → `metrics.byMachine.map`; key on `m.machineId` | |
| 272–274 | `{m.hours}h` → `{formatHours(m.hours)}h` | |
| 286–291 | `"15 min"` → `` `${appInfo.idleTimeoutMin} min` `` | PRD §7: adjustable 10–15 |
| 295–297 | **Keep** the "Press d" hint verbatim | the provider implements it |
| — | **Insert** `<DoctorPanel />` after the bottom split, behind the header toggle | §6 |

**Not changed, and worth stating so nobody "improves" it:** `min-h-svh`, `max-w-[1100px]`, `px-8 py-10`, every `rounded-lg border border-border bg-card`, every gap and margin, the `ChartContainer` height of `180px`, `maxBarSize={34}`, `blockSize/blockMargin/blockRadius`, and every `tabular-nums`.

### 5.7 The new code

```tsx
// src/renderer/src/App.tsx — the head of the file, replacing lines 30–60
import { ActivityCalendar } from "react-activity-calendar"
import "react-activity-calendar/tooltips.css"
// … the reference's other imports, unchanged …
import { DegradedBanner } from "@/DegradedBanner"
import { DoctorPanel } from "@/DoctorPanel"
import { ipc, useAppInfo, useLiveStatus, useMetrics, useNowMs, useToggles } from "@/lib/ipc"
import { useResolvedTheme } from "@/lib/use-resolved-theme"
import { useThemeMirror } from "@/lib/use-theme-mirror"
import {
  creditedOpenMs, formatAgo, formatCount, formatDuration,
  formatHeaderDate, formatHours, formatWeekDelta,
} from "@shared/format"

const chartConfig = {
  hours: { label: "Hours", color: "var(--foreground)" },
} satisfies ChartConfig
```

```tsx
// StatCard — replacing lines 62–91
function StatCard({
  label, value, unit, sub, warn = false,
}: {
  label: string
  /** null renders '—'. A real 0 renders '0'. They are different things. */
  value: string | null
  unit?: string
  sub?: string | null
  warn?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-heading text-[28px] leading-none font-semibold tracking-tight tabular-nums">
          {value ?? "—"}
        </span>
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
        {warn ? <span className="text-destructive ml-1 text-sm" title="This number is incomplete — see the banner above">⚠︎</span> : null}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{sub ?? " "}</div>
    </div>
  )
}
```

The `sub` line always renders — a non-breaking space when empty — so the four cards keep identical heights on first run. That is the "grid does not reflow when data arrives" requirement from PRD §4.

```tsx
// App() — the body, replacing lines 118–124 and the sections that consume data
export function App() {
  useThemeMirror()

  const status = useLiveStatus()
  const appInfo = useAppInfo()
  const [toggles, setToggle] = useToggles()
  const resolvedTheme = useResolvedTheme()
  const { data: metrics } = useMetrics()

  // 1 Hz display clock. Armed only while an interval is open, and every read
  // recomputes from ABSOLUTE epoch ms — so if this timer collapses (it is a
  // renderer timer; AGENTS.md trap #10) the next tick is still correct.
  // Nothing is scheduled from status.deadlineMs. Ever.
  const nowMs = useNowMs(status?.state === "working")

  const working = status?.state === "working"
  const openMs = status ? creditedOpenMs(status, nowMs) : 0
  const keyboardBroken = !!status?.degraded.includes("keyboard_permission_missing")

  return (
    <div className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-8 py-10">
        <header className="flex items-start justify-between [-webkit-app-region:drag]">
          <div>
            <h1 className="font-heading text-[22px] leading-tight font-semibold tracking-tight">
              Work Week Buddy
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{formatHeaderDate(nowMs)}</p>
          </div>
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <ThemeToggle />
          </div>
        </header>

        <DegradedBanner reasons={status?.degraded ?? []} />

        {/* Live status strip — layout identical to the reference */}
        <section className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <span className="relative flex size-2">
            {working && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40" />
            )}
            <span className={`relative inline-flex size-2 rounded-full ${working ? "bg-foreground" : "bg-muted-foreground/40"}`} />
          </span>
          <span className="text-sm font-medium">
            {status?.state === "working" ? "Working" : status?.state === "paused" ? "Paused" : "Idle"}
          </span>
          <span className="font-mono text-sm text-muted-foreground tabular-nums">
            {formatDuration(openMs)}
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Laptop className="size-3.5" />
            {status?.machineLabel || "this Mac"}
          </span>
          <Separator orientation="vertical" className="mx-1 !h-4" />
          <span className="text-sm text-muted-foreground">
            last signal{" "}
            <span className="tabular-nums">
              {status?.lastSignalMs === null || status === null ? "—" : formatAgo(nowMs - status.lastSignalMs)}
            </span>{" "}
            ago
          </span>
          <div className="ml-auto flex items-center gap-4">
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={toggles?.jigglerUnavailableReason ?? undefined}
            >
              <MousePointer2 className="size-3.5" />
              Jiggler
              <Switch
                checked={!!toggles?.jiggler}
                disabled={!toggles?.jigglerAvailable}
                onCheckedChange={(v) => setToggle("jiggler", v)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Coffee className="size-3.5" />
              Keep awake
              <Switch
                checked={!!toggles?.keepAwake}
                onCheckedChange={(v) => setToggle("keepAwake", v)}
              />
            </label>
          </div>
        </section>

        {/* Stat row */}
        <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="This week"
            value={formatHours(metrics?.week.hours ?? null)}
            unit="h"
            sub={formatWeekDelta(metrics?.week.hours ?? null, metrics?.week.prevHours ?? null)}
            warn={keyboardBroken}
          />
          <StatCard
            label="Avg interval · week"
            value={metrics ? formatDuration((metrics.interval.avgMin ?? 0) * 60_000) : null}
            sub={metrics ? `${formatCount(metrics.interval.nIntervals)} intervals` : null}
          />
          <StatCard
            label="Avg interval · all time"
            value={metrics ? formatDuration((metrics.allTime.avgMin ?? 0) * 60_000) : null}
            sub={metrics ? `${formatCount(metrics.allTime.nIntervals)} intervals` : null}
          />
          <StatCard
            label="Longest interval"
            value={metrics?.longest.singleHours != null
              ? formatDuration(metrics.longest.singleHours * 3_600_000) : null}
            sub={metrics?.longest.singleDate
              ? `${metrics.longest.singleDate} · ${metrics.longest.singleMachineLabel ?? "unknown"}`
              : null}
          />
        </section>

        {/* Heatmap */}
        <section className="mt-4 rounded-lg border border-border bg-card px-5 py-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-sm font-medium">Daily hours</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {metrics?.allTime.hoursTracked != null
                ? `${formatCount(Math.round(metrics.allTime.hoursTracked))} h tracked since ${metrics.allTime.sinceDate}`
                : "—"}
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <ActivityCalendar
              data={metrics?.heatmap ?? []}
              loading={!metrics}
              colorScheme={resolvedTheme}
              blockSize={11}
              blockMargin={3}
              blockRadius={2}
              fontSize={11}
              weekStart={1}
              maxLevel={4}
              showWeekdayLabels={["mon", "wed", "fri"]}
              showTotalCount={false}
              theme={{
                light: ["#F1F0EE", "#D3D1CB", "#A8A49C", "#6B6862", "#37352F"],
                dark: ["#242424", "#3A3A3A", "#5C5C5C", "#8A8A8A", "#D4D4D4"],
              }}
              labels={{ legend: { less: "0h", more: "8h+" } }}
              tooltips={{ activity: { text: (a) => `${a.count.toFixed(1)} h on ${a.date}` } }}
            />
          </div>
        </section>

        {/* … bottom split: <BarChart data={metrics?.weekBars ?? []}> and
            metrics.byMachine.map(...), otherwise identical to the reference … */}

        <DoctorPanel />
      </div>
    </div>
  )
}
```

`loading={!metrics}` is a v3 prop and renders the calendar's own skeleton at full size — which is the empty-state requirement for the largest card on the page.

### 5.8 The heatmap level — an amendment `docs/IMPL_DATA.md` must honour

`docs/DATA_MODEL.md` query 4 computes the level as:

```sql
MIN(4, CAST(SUM(e_ms - s_ms)/3600000.0 / NULLIF(:level_step_h, 0) AS INTEGER)) AS level
```

With any step, this maps a short workday to level 0 — identical to a day off. With `:level_step_h = 2`, a 1.9-hour day and a zero-hour day are the same shade. `design/App.reference.tsx:34-40` does not do that: `levelFor` gives `0 → 0`, `(0, 2) → 1`, `[2, 5) → 2`, `[5, 8) → 3`, `≥8 → 4`, which is what the mockup shows and what the legend (`less: "0h"`, `more: "8h+"`) describes.

**Required:** move the mockup's thresholds into the query, keeping the level in SQL where the policy belongs (`AGENTS.md`: policy knobs live in the query layer, never in application code).

```sql
-- query 4, level column
CASE
  WHEN SUM(e_ms - s_ms) <= 0            THEN 0
  WHEN h < :l1                          THEN 1
  WHEN h < :l2                          THEN 2
  WHEN h < :l3                          THEN 3
  ELSE 4
END AS level
-- binds: :l1 = 2, :l2 = 5, :l3 = 8   ⇐ MetricsPolicy.heatmapThresholdsH
```

The renderer must **not** recompute the level. `levelFor` is deleted, not ported.

### 5.9 `tabular-nums` audit

Every number that changes on a timer or on data arrival needs it, or the layout jitters. Present in the reference at lines 79, 147, 157, 202, 272, 288. **Add** it to:

- the "last signal" value (already at 157 — verify it survives the edit)
- the `formatHeaderDate` line? **No** — it changes once a day, and the date is prose.
- the tray title — via `fontType: "monospacedDigit"` (§3.1), not CSS.

The Recharts axis labels are day names, not numbers, and are left alone.

---

## 6. The doctor panel

**What it is for.** Every one of the 13 traps in `AGENTS.md` fails silently. The doctor panel is the one screen where each of them becomes a visible value with a timestamp. `--doctor` prints the same `DoctorReport` as JSON and exits non-zero if anything is red — which is how `scripts/install.sh` gates the install (`ARCHITECTURE.md` §6 step 7).

### 6.1 What it shows

| Group | Row | Green when | Red means |
|---|---|---|---|
| **Permissions** | Input Monitoring | `keyboardBitsGranted` | typing is invisible; hours run low forever (trap #2) |
| | ‑ modifier keys | `flagsChangedBitGranted` | shift/cmd/ctrl presses invisible (trap #3) |
| | Accessibility | `accessibility === "granted"` | jiggler is a dead switch |
| | Restart needed | `!relaunchRequired` | a grant landed but this process cannot use it |
| | Microphone | `microphone === "not-required"` | it prompted — M1 gate (g) failed; report loudly |
| **Tap health** | Created / enabled | both true | |
| | Granted mask | hex, with the keyboard + flagsChanged bits called out | trap #2, #3 |
| | Run-loop modes | contains **both** `default` and `common` | `common` alone yields exactly 0 events, silently (trap #1) |
| | Events since launch | `> 0` after 60 s | M1 gate (b) |
| | Last event | `formatAgo` | |
| | Disabled-by-timeout / re-enabled | counts | a slow callback disabled the tap (trap #13) |
| | `tap_lost` rows | **0** — this is a soak-gate metric | every interval closed 15 min early |
| | Last watchdog tick | `< 6 min` ago | the one documented 5-minute read-only tick is dead |
| **Sync** | Pending rows | any number; it drains | |
| | Last successful flush | `< 72 h` | |
| | Last error | none | |
| | Watermark / last pull | | |
| | Silent for | `< 72 h` | backup layer 4: the free-tier-disappeared alarm |
| **Fingerprint** | Matched | `true` | **the layer that catches silent loss.** Shows local vs cloud count and both sha256 prefixes |
| | Checked at | `< 8 days` ago | |
| **Backup** | Last file, destination, age | `< 8 days` | backup layer 2 |
| | Kept | ≤ 52 | |
| **Self-test** | Result + date + app version | `passed` | our own jiggle was **not** identified as ours → 24-hour workdays (trap #4) |
| **Identity** | Bundle id, exec path, `execMatchesRunningApp` | running from `/Applications/Work Week Buddy.app` | you are looking at the dev build's grants, not the packaged app's (`AGENTS.md`, Environment) |
| | Designated requirement sha256 | identical on both Macs | M7 gate (a) |
| | LaunchAgent installed / loaded | both true | |
| **Local DB** | Path, size, rows, integrity | `integrityOk` | |
| | Open-interval journal present | matches `state === "working"` | crash recovery will disagree with reality |
| **Machine** | machineId, label, tz, OS version | | |

Two things the panel must show even when green, because their *absence* is the failure: **`tap_lost` rows** and **the self-test date**. A self-test that last passed four builds ago is not evidence about this build.

### 6.2 Rendering rules

- `DoctorReport` arrives once via `wwb:doctor:get` on mount, then via `wwb:push:doctor` every 10 s **only while the panel is open**. Main starts that timer when the first `wwb:doctor:get` arrives and stops it when every window is gone.
- Every timestamp renders as **both** the absolute local time and `formatAgo` — "2026-08-19 14:02 (3m ago)". A relative time alone is useless when comparing two Macs; an absolute time alone is useless when scanning.
- Red rows sort to the top. Green rows stay in the order above so the layout is stable between refreshes.
- **Run self-test** and **Sync now** buttons. The self-test posts a tagged jiggle: disable the button when Accessibility is missing, with the reason in a `title`.
- Nothing in this panel is editable. It is a mirror, not a control surface. The three toggles live in the tray and the status strip; machine rename lives in settings.

### 6.3 `src/renderer/src/DoctorPanel.tsx` — the shape

```tsx
// src/renderer/src/DoctorPanel.tsx
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ipc } from "@/lib/ipc"
import { formatAgo } from "@shared/format"
import type { DoctorReport } from "@shared/ipc-types"

type Row = { label: string; value: string; ok: boolean | null; hint?: string }

function when(ms: number | null, nowMs: number): string {
  if (ms === null) return "never"
  return `${new Date(ms).toLocaleString()} (${formatAgo(nowMs - ms)} ago)`
}

function rowsFor(d: DoctorReport, now: number): Array<{ group: string; rows: Row[] }> {
  return [
    { group: "Permissions", rows: [
      { label: "Input Monitoring (keyboard bits)", value: String(d.permissions.keyboardBitsGranted), ok: d.permissions.keyboardBitsGranted,
        hint: "The granted event-tap mask is the authority, not the preflight call." },
      { label: "Modifier keys (flagsChanged)", value: String(d.permissions.flagsChangedBitGranted), ok: d.permissions.flagsChangedBitGranted },
      { label: "Accessibility", value: d.permissions.accessibility, ok: d.permissions.accessibility === "granted" },
      { label: "Restart required", value: String(d.permissions.relaunchRequired), ok: !d.permissions.relaunchRequired },
      { label: "Microphone", value: d.permissions.microphone, ok: d.permissions.microphone === "not-required" },
    ]},
    { group: "Tap health", rows: [
      { label: "Enabled", value: String(d.tap.enabled), ok: d.tap.enabled },
      { label: "Granted mask", value: d.tap.grantedMaskHex, ok: d.tap.keyboardBitsPresent && d.tap.flagsChangedBitPresent },
      { label: "Run-loop modes", value: d.tap.runLoopModes.join(" + "), ok: d.tap.runLoopModes.length === 2,
        hint: "Common mode alone yields exactly 0 events, with no error." },
      { label: "Events since launch", value: String(d.tap.eventsSinceLaunch), ok: d.tap.eventsSinceLaunch > 0 },
      { label: "Last event", value: when(d.tap.lastEventMs, now), ok: null },
      { label: "Disabled by timeout / re-enabled", value: `${d.tap.disabledByTimeoutCount} / ${d.tap.reEnabledCount}`, ok: null },
      { label: "tap_lost rows", value: String(d.tap.tapLostRows), ok: d.tap.tapLostRows === 0 },
      { label: "Last watchdog tick", value: when(d.tap.lastWatchdogTickMs, now),
        ok: d.tap.lastWatchdogTickMs !== null && now - d.tap.lastWatchdogTickMs < 6 * 60_000 },
    ]},
    { group: "Sync", rows: [
      { label: "Pending rows", value: String(d.sync.pendingRows), ok: null },
      { label: "Last flush", value: when(d.sync.lastFlushOkMs, now), ok: d.sync.lastFlushError === null },
      { label: "Last error", value: d.sync.lastFlushError ?? "none", ok: d.sync.lastFlushError === null },
      { label: "Silent for", value: d.sync.silentForMs === null ? "—" : formatAgo(d.sync.silentForMs),
        ok: d.sync.silentForMs === null || d.sync.silentForMs < 72 * 3_600_000 },
      { label: "Pull watermark", value: String(d.sync.watermark), ok: null },
    ]},
    { group: "Fingerprint", rows: [
      { label: "Matched", value: String(d.fingerprint.matched), ok: d.fingerprint.matched },
      { label: "Counts (local / cloud)", value: `${d.fingerprint.localCount ?? "—"} / ${d.fingerprint.cloudCount ?? "—"}`,
        ok: d.fingerprint.localCount === d.fingerprint.cloudCount },
      { label: "sha256 (local / cloud)", value: `${d.fingerprint.localSha?.slice(0, 12) ?? "—"} / ${d.fingerprint.cloudSha?.slice(0, 12) ?? "—"}`, ok: null },
      { label: "Checked", value: when(d.fingerprint.checkedAtMs, now),
        ok: d.fingerprint.checkedAtMs !== null && now - d.fingerprint.checkedAtMs < 8 * 86_400_000 },
    ]},
    { group: "Backup", rows: [
      { label: "Last export", value: d.backup.lastPath ?? "none", ok: d.backup.lastPath !== null },
      { label: "Age", value: d.backup.ageDays === null ? "—" : `${d.backup.ageDays} days`, ok: (d.backup.ageDays ?? 99) < 8 },
      { label: "Destination", value: d.backup.destination ?? "—", ok: null },
    ]},
    { group: "Self-test", rows: [
      { label: "Result", value: d.selfTest ? (d.selfTest.passed ? "passed" : "FAILED") : "never run", ok: d.selfTest?.passed ?? false,
        hint: "Round-trips a tagged jiggle and asserts it is identified as ours." },
      { label: "Ran", value: when(d.selfTest?.ranAtMs ?? null, now), ok: null },
      { label: "App version at run", value: d.selfTest?.appVersion ?? "—", ok: d.selfTest?.appVersion === d.app.version },
    ]},
    { group: "Identity", rows: [
      { label: "Executable", value: d.app.execPath, ok: d.autostart.execMatchesRunningApp,
        hint: "Dev and packaged builds are different apps to macOS, with independent grants." },
      { label: "Designated requirement", value: d.codesign.designatedRequirementSha256?.slice(0, 16) ?? "—", ok: d.codesign.valid },
      { label: "LaunchAgent", value: `${d.autostart.installed ? "installed" : "missing"} / ${d.autostart.loaded ? "loaded" : "not loaded"}`,
        ok: d.autostart.installed && d.autostart.loaded },
    ]},
    { group: "Local database", rows: [
      { label: "Path", value: d.db.path, ok: null },
      { label: "Rows / size", value: `${d.db.rows} / ${(d.db.sizeBytes / 1_048_576).toFixed(1)} MB`, ok: null },
      { label: "Integrity", value: String(d.db.integrityOk), ok: d.db.integrityOk },
      { label: "Open-interval journal", value: String(d.db.openIntervalPresent), ok: null },
    ]},
  ]
}

export function DoctorPanel() {
  const [open, setOpen] = React.useState(false)
  const [report, setReport] = React.useState<DoctorReport | null>(null)
  const now = Date.now()

  React.useEffect(() => {
    if (!open) return
    void ipc.doctor().then(setReport)
    return window.wwb.on("wwb:push:doctor", setReport)
  }, [open])

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground mt-8 block w-full text-center text-xs">
        Doctor
      </button>
    )
  }

  return (
    <section className="mt-4 rounded-lg border border-border bg-card px-5 py-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-heading text-sm font-medium">Doctor</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void ipc.flush().then(() => ipc.doctor().then(setReport))}>Sync now</Button>
          <Button size="sm" variant="ghost"
            disabled={report?.permissions.accessibility !== "granted"}
            title={report?.permissions.accessibility !== "granted" ? "Needs Accessibility" : undefined}
            onClick={() => void ipc.selfTest().then(() => ipc.doctor().then(setReport))}>Run self-test</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Hide</Button>
        </div>
      </div>

      {report && rowsFor(report, now).map((g) => (
        <div key={g.group} className="mt-4">
          <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{g.group}</div>
          <div className="mt-2 flex flex-col gap-1">
            {[...g.rows].sort((a, b) => Number(a.ok === false ? 0 : 1) - Number(b.ok === false ? 0 : 1)).map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-4 text-sm" title={r.hint}>
                <span className={r.ok === false ? "text-destructive" : "text-muted-foreground"}>{r.label}</span>
                <span className={`font-mono text-xs tabular-nums ${r.ok === false ? "text-destructive" : ""}`}>{r.value}</span>
              </div>
            ))}
          </div>
          <Separator className="mt-3" />
        </div>
      ))}
    </section>
  )
}
```

---

## 7. Tests

`vitest` for everything in `src/shared/` and `src/main/` that is pure. Playwright-via-Electron (`_electron.launch`) for the integration rows. Manual only where the row says so — those are the ones that need a human, a lid, or System Settings.

### 7.1 Unit — `src/shared/format.ts`

| id | Assertion |
|---|---|
| `F01` | `creditedOpenMs` returns `lastSignalMs − openedAtMs` when `heldOpenBy === null`, **regardless of how far `nowMs` is in the future**. Property test over arbitrary `nowMs`. |
| `F02` | `creditedOpenMs` never returns a value that would put the interval end after `nowMs`. |
| `F03` | `creditedOpenMs` with a camera hold clamps to `heldUntilMs`. |
| `F04` | `hoursThisWeek` adds **zero** for the open interval when `jigglerOnForOpenInterval && countJigglerTime === 0`. |
| `F05` | `hoursThisWeek` adds zero when the open interval is under `minIntervalS`. |
| `F06` | `hoursThisWeek` returns `null` (not `0`) when `closedHoursThisWeek === null` and nothing is open. |
| `F07` | `formatHours(null) === "—"` and `formatHours(0) === "0.0"`. They differ. |
| `F08` | `startOfIsoWeek` returns Monday 00:00 local across a DST spring-forward and fall-back boundary (America/Chicago, 2026-03-08 and 2026-11-01). |
| `F09` | `localDateString` for `2026-08-19T23:30:00-05:00` is `2026-08-19`, **not** `2026-08-20`. This is the UTC bug in `design/mock-data.reference.ts:28`. |
| `F10` | `nextIsoWeekStart` is always in `(now, now + 8 days]`, over a year of random instants. |
| `F11` | `formatTrayTitle(36.5, false) === "36.5h"`; `formatTrayTitle(null, true) === "—h ⚠︎"`. |

### 7.2 Unit — main process, no window

| id | Assertion |
|---|---|
| `M01` | `readCliMode` maps every flag; unknown flags fall through to `normal`. |
| `M02` | `TrayController` **creates no minute timer** while `state !== "working"`, and creates exactly one when it becomes `working`. Assert on a fake-timer count, not on wall time. |
| `M03` | On `interval-close`, the minute timer is cleared and exactly one rollover timer is armed. |
| `M04` | `onRuntimeChange("signal")` triggers **zero** `setTitle` calls. Feed 300 of them. |
| `M05` | Week rollover: with fake timers, advancing past Monday 00:00 re-renders the title with the new week's number. |
| `M06` | Jiggler toggle calls `setToggle` and **awaits it** before reading `liveStatus()`. Assert the call order with a deferred mock. |
| `M07` | `offerPause` does not show a dialog when `jigglerPausePrompt === "never"`, and sets it when the checkbox is returned. |
| `M08` | `pushToAllWindows("interval-close")` debounces `metrics-stale` to one message for a burst of five closes inside 2 s. |
| `M09` | The protocol handler rejects `app://wwb/../../etc/passwd` with 403. |
| `M10` | The protocol handler's response carries the exact CSP string, including `style-src 'self' 'unsafe-inline'`. |
| `M11` | `assertTrustedSender` throws for `https://evil.example` and passes for `app://wwb/index.html`. |
| `M12` | Every channel in `INVOKE_CHANNELS` has a registered `ipcMain.handle`, and every registered handler is in `INVOKE_CHANNELS`. Set equality, both directions — this catches a handler added without a contract entry and vice versa. |
| `M13` | The preload rejects an invoke on a channel not in the allowlist. |

### 7.3 Integration — a launched app

**`npm run smoke` is the built one.** `src/main/smoke.ts` launches the app with
`--smoke`, opens *both* windows through the real `showDashboard()` /
`showOnboarding()` over the real `app://` protocol, and measures them from
inside the page. It exists because the entire dashboard once shipped crammed
into the 560 × 640 onboarding window past a fully green suite: every renderer
test mounts a component in a jsdom with no window, no size, no URL and no
layout engine, so not one of them could have seen it.

It asserts, per window and in two scenarios (`degraded` = the fresh-install
state, `granted` = the same windows after a live `wwb:push:permissions`):

- the view the renderer mounted is the window the main process opened;
- neither window's content is wider than its viewport;
- the dashboard is at least `WINDOW_SIZE.dashboard.minWidth` wide and shows
  "This week";
- the onboarding window is exactly 560 × 640, is not resizable, and its panes
  fit with ≥ 16 px to spare;
- `relaunchRequired` is stated in the window, and stops being stated after the
  push — with nothing reloaded;
- the jiggler switch is disabled without Accessibility, live with it, and
  clicking it reaches `runtime.toggles().jiggler` rather than only the DOM.

The rules live in `src/main/smoke-report.ts`, which is pure and unit-tested, so
they run in the Linux CI job too; the macOS job runs the launch. Screenshots and
`smoke-report.json` land in `$WWB_SMOKE_DIR`, in both palettes, which covers the
screenshot half of `H05` below.

It runs the **built** bundle rather than the signed `.app`: `src/native/index.ts`
refuses the fake `SignalSource` in a packaged build on purpose, so a packaged run
would need real TCC grants and could not run unattended. The `app://` handler,
the loaded URL, the renderer bundle and the window geometry are identical
between the two — `npm run selftest` and `npm run doctor` are what inspect the
installed copy.

The rows below are the launched-app cases that are still **not** built.

| id | Assertion | How |
|---|---|---|
| **`UI-T01`** | **Closing the dashboard window does not stop tracking and does not freeze the tray.** Open the window, close it, inject signals for 3 simulated minutes, assert the tray title still advances and a closed interval lands in the DB. | `_electron.launch`, fake clock in the runtime, read `tray.getTitle()` via a test-only IPC channel registered under `NODE_ENV=test` |
| **`UI-T02`** | **Revoking a permission produces a visible degraded state, not a silent zero.** Flip the mocked `grantedMask()` to drop the keyboard bits, fire a watchdog tick, assert: tray icon is `trayAlertTemplate`, tray title ends in `⚠︎`, the top tray menu item is the fix item, and `DegradedBanner` renders in an open window. | mock `native.grantedMask` |
| `UI-T03` | With **no** permissions at all, first launch opens the onboarding window; with both granted it opens no window. | |
| `UI-T04` | A second launch exits immediately with code 0 and the first instance shows the dashboard (`second-instance`). M3 gate (b). | |
| `UI-T05` | `--selftest` exits non-zero when the tagged jiggle is not identified as ours, and does **not** take the single-instance lock. | |
| `UI-T06` | `powerMonitor` `suspend` does **not** close the interval; `resume` after the deadline closes it at the pre-sleep signal with `end_reason = 'sleep'`. | emit the events directly |
| `UI-T07` | `resume` re-evaluates the deadline **before** `flushNow()`, so the closed row is in the outbox on the first flush. Assert call order. | |
| `UI-T08` | `before-quit` closes the interval with `end_reason = 'app_quit'` and exits within 5 s even if `stop()` hangs. | make `stop()` never resolve |
| `UI-T09` | Toggling the jiggler while an interval is open writes exactly two rows, contiguous (`row1.ended_at_ms === row2.started_at_ms`), and each is homogeneous (`jiggler_s === 0 \|\| jiggler_s === duration_s`). M5 gate (b), M2 gate (e). | |
| `UI-T10` | Toggling the jiggler while idle writes **no** row. | |
| `UI-T11` | The jiggler menu item and the dashboard `Switch` are both **disabled** when Accessibility is missing, and both carry the reason. | |
| `UI-T12` | `wwb:permissions:relaunch` calls `runtime.stop("app_quit")` before `app.relaunch()`. Assert order. | |
| `UI-T13` | The renderer cannot reach the DB: `window.require`, `window.process` and `window.electron` are all `undefined`; `window.wwb.invoke("wwb:evil")` rejects. | |
| `UI-T14` | The permission poll stops when the onboarding window closes, and after 45 s regardless. | fake timers |

### 7.4 Renderer

| id | Assertion |
|---|---|
| `R01` | Every `StatCard` renders `—` and keeps its height when `metrics === null`. Snapshot the grid's bounding boxes with and without data — they must be identical. PRD §4. |
| `R02` | `useResolvedTheme` flips when the `.dark` class is added to `<html>`, and `ActivityCalendar` receives the new `colorScheme`. |
| `R03` | `useNowMs` is **not** armed when `state !== "working"`. |
| `R04` | The status strip's duration never exceeds `nowMs − openedAtMs`, over a scripted stream of pushes. |
| `R05` | The ping animation renders only when `working`. |
| `R06` | `useMetrics` re-invokes exactly once per `metrics-stale` push, and cancels nothing in flight incorrectly. |
| `R07` | Every push subscription returns and calls its unsubscribe on unmount. Mount/unmount 50 times, assert `ipcRenderer.listenerCount` is back to 0. |

### 7.5 Manual — the rows a human has to do

| id | Step | Gate |
|---|---|---|
| `H01` | Turn the jiggler on with display sleep at 1 minute. Watch for 10 minutes. | The display does not sleep **and the cursor never moves one pixel.** M5 (a) |
| `H02` | Type during `H01`. | The typing lands in an interval marked jiggler-covered. M5 (b) |
| `H03` | `pmset -g assertions` with keep-awake on, then off. | Exactly one assertion, then none. M5 (d) |
| `H04` | Remove the app from Input Monitoring in System Settings while it runs. | Within 5 minutes: red banner, `⚠︎` in the tray title, alert icon. M5 (c) |
| `H05` | Build, install, screenshot the dashboard in **the built app** in both themes. | Matches `design/mockup-notion-warm-*.png`. M6 (f) |
| `H06` | Open DevTools in the built app. | No console errors; no CSP violations. M6 (e) |
| `H07` | Close the dashboard, check RSS. | Recovers the renderer's memory. M6 (d) |
| `H08` | Resize the window to exactly 880 px. | The heatmap does not scroll. Below 880, it scrolls inside its card and the page body never scrolls horizontally. |
| `H09` | Launch with the theme set to dark. | No white flash before the first paint. §5.5 |
| `H10` | Close the lid for 3 minutes, then for 2 hours. | One continuous interval, then a close truncated to the pre-sleep signal. M7 (g) |

---

## Appendix — decisions made here, so nobody re-litigates them

| Decision | Alternative rejected | Why |
|---|---|---|
| Destroy the dashboard window on close | Hide it | ARCHITECTURE §1 says the renderer exists only while the window is open, and M6 gate (d) measures the memory that comes back |
| Push complete snapshots, never deltas | Delta events | deltas need ordering guarantees IPC does not give |
| Push `metrics-stale`, not metrics | Push `MetricsBundle` | main does not know which policy the renderer is currently displaying |
| One `AppRuntime` interface as the only seam | Import store/core directly from tray and ipc | keeps `src/core/` electron-free and makes the whole UI layer testable against a fake |
| `app://` with `standard: true` | `file://` | Vite emits ESM, which Electron cannot load over `file://` |
| CSP as a response header from the protocol handler | `<meta http-equiv>` | one policy, one place; two policies intersect and fail confusingly |
| A real `public/theme-boot.js` | an inline `<script>` + `script-src 'unsafe-inline'` or a build-time hash | keeps `script-src 'self'` with no build step |
| Copy `theme-provider.reference.tsx` verbatim + a `useResolvedTheme` hook | Add `resolvedTheme` to the provider | `design/README.md` says do not rewrite it; the class it writes is already the truth |
| Tray credits the open interval to `lastSignalMs` | Credit to `now` | crediting to `now` makes the headline number **shrink** by up to 15 minutes when the interval closes |
| The LaunchAgent plist is the only autostart | also `app.setLoginItemSettings()` | two launch paths race the single-instance lock and make the doctor panel lie |
| `app.exit(0)` for the single-instance loser | `app.quit()` | `quit()` fires `before-quit`, which would close the **running** instance's interval from the doomed process |
| Poll permissions at 1 Hz in **main** | poll in the renderer | the onboarding window spends its life behind System Settings, and hidden renderer timers collapse (trap #10) |
| `end_reason = 'jiggler_boundary'` | reuse `paused` or `idle_timeout` | mislabelling it makes the soak-test counters lie |
| Heatmap level thresholds `[2, 5, 8]` in SQL | `:level_step_h` division | a 1.9-hour day would otherwise render identically to a day off |
| Label the toggle **Keep awake** everywhere | keep the mockup's "Caffeinate" | `caffeinate` is a banned implementation (MACOS.md §5); one name per toggle |
