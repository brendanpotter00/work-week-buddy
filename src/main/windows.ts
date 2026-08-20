/**
 * The windows — `docs/IMPL_UI.md` §1.5.
 *
 * A window is a VIEW, not the app. The dashboard is destroyed on close (not
 * hidden), tracking continues without it, and the tray title keeps advancing
 * from the main process. `ARCHITECTURE.md` §1: the renderer only exists while
 * the dashboard window is open.
 */
import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
import { ROUTE, WINDOW_SIZE } from "../shared/constants";
import { APP_ORIGIN } from "./protocol";

/**
 * CommonJS preload. `docs/IMPL_UI.md` §1.10: an ESM preload under
 * `sandbox: true` silently fails to load — `window.wwb` is simply `undefined`
 * and every IPC call throws "cannot read invoke", with no renderer error worth
 * reading. The preload build is pinned to `cjs` in `electron.vite.config.ts`.
 */
function preloadPath(): string {
  return join(app.getAppPath(), "out", "preload", "index.js");
}

const isDev = (): boolean => !!process.env["ELECTRON_RENDERER_URL"];

let dashboard: BrowserWindow | null = null;
let onboarding: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    contextIsolation: true, // required
    nodeIntegration: false, // required
    // Chromium's RENDERER sandbox. This is not macOS App Sandbox, which is
    // banned (AGENTS.md #12) because it kills camera detection. Do not "fix"
    // one by disabling the other.
    sandbox: true,
    webviewTag: false,
    spellcheck: false,
    devTools: isDev(),
  };
}

/**
 * The hash IS the view (`ROUTE` in `src/shared/constants.ts`). The renderer
 * reads it back in `src/renderer/lib/route.ts`; nothing else distinguishes the
 * two windows, in dev or in the packaged bundle.
 *
 * Exported and pure so the SEAM can be tested from BOTH ENDS AT ONCE:
 * `test/renderer/routing.test.tsx` feeds this exact URL through `routeOf()` and
 * asserts the right view comes back. A URL form this side emits and the other
 * side does not match is the bug that shipped, and it is invisible to any test
 * that exercises only one half.
 *
 * `/index.html` is spelled out rather than left to the origin's default
 * document: `app://wwb#/onboarding` has no path at all, and a hash hung off a
 * bare origin is the form most likely to be dropped by a redirect.
 */
export function viewUrl(base: string, hash: string): string {
  return `${base}/index.html#${hash}`;
}

/** Where this build serves the renderer from. Dev is a Vite server. */
export function rendererBase(): string {
  return process.env["ELECTRON_RENDERER_URL"] ?? APP_ORIGIN;
}

function load(win: BrowserWindow, hash: string): Promise<void> {
  return win.loadURL(viewUrl(rendererBase(), hash));
}

function lockDownNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !url.startsWith("http://localhost:")) e.preventDefault();
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}

export async function showDashboard(backgroundColor = "#FFFFFF"): Promise<BrowserWindow> {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }

  dashboard = new BrowserWindow({
    // The geometry, and the arithmetic behind 880, live in
    // `src/shared/constants.ts` — the smoke run asserts against the same
    // numbers, and a window size that is checked elsewhere needs one home.
    ...WINDOW_SIZE.dashboard,
    show: false,
    title: "Work Week Buddy",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    // Painted before the renderer's first frame. Main cannot read the
    // renderer's localStorage, so the theme is mirrored into main-side settings.
    backgroundColor,
    webPreferences: baseWebPreferences(),
  });

  lockDownNavigation(dashboard);
  dashboard.once("ready-to-show", () => dashboard?.show());
  // Destroy, do not hide: the renderer's memory comes back.
  dashboard.on("closed", () => {
    dashboard = null;
  });

  await load(dashboard, ROUTE.dashboard);
  return dashboard;
}

export async function showOnboarding(backgroundColor = "#FFFFFF"): Promise<BrowserWindow> {
  if (onboarding && !onboarding.isDestroyed()) {
    onboarding.show();
    onboarding.focus();
    return onboarding;
  }
  onboarding = new BrowserWindow({
    ...WINDOW_SIZE.onboarding,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Permissions",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor,
    webPreferences: baseWebPreferences(),
  });
  lockDownNavigation(onboarding);
  onboarding.once("ready-to-show", () => onboarding?.show());
  onboarding.on("closed", () => {
    onboarding = null;
  });
  await load(onboarding, ROUTE.onboarding);
  return onboarding;
}

/**
 * The settings window.
 *
 * ITS OWN WINDOW, and reachable from the tray without the dashboard, because
 * that is where sync gets configured and the tray is where this app lives. It
 * is also why it is not a panel inside the dashboard: opening a 1100-px window
 * to reach two text fields is a step nobody takes, and the owner's whole
 * complaint was that there was no way in at all.
 *
 * Resizable, unlike onboarding: it holds two editable lists whose length is the
 * user's business. `minWidth`/`minHeight` (`WINDOW_SIZE.settings`) are what
 * keep the sync form reachable at any size it can be dragged to.
 */
export async function showSettings(backgroundColor = "#FFFFFF"): Promise<BrowserWindow> {
  if (settings && !settings.isDestroyed()) {
    settings.show();
    settings.focus();
    return settings;
  }
  settings = new BrowserWindow({
    ...WINDOW_SIZE.settings,
    show: false,
    title: "Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor,
    webPreferences: baseWebPreferences(),
  });
  lockDownNavigation(settings);
  settings.once("ready-to-show", () => settings?.show());
  settings.on("closed", () => {
    settings = null;
  });
  await load(settings, ROUTE.settings);
  return settings;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settings && !settings.isDestroyed() ? settings : null;
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboarding && !onboarding.isDestroyed() ? onboarding : null;
}

export function getDashboardWindow(): BrowserWindow | null {
  return dashboard && !dashboard.isDestroyed() ? dashboard : null;
}

export function closeAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
}
