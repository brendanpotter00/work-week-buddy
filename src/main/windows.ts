/**
 * The two windows — `docs/IMPL_UI.md` §1.5.
 *
 * A window is a VIEW, not the app. The dashboard is destroyed on close (not
 * hidden), tracking continues without it, and the tray title keeps advancing
 * from the main process. `ARCHITECTURE.md` §1: the renderer only exists while
 * the dashboard window is open.
 */
import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
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

function load(win: BrowserWindow, hash: string): Promise<void> {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return dev
    ? win.loadURL(`${dev}/index.html#${hash}`)
    : win.loadURL(`${APP_ORIGIN}/index.html#${hash}`);
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
    width: 1100,
    height: 860,
    // 880 is not a round number. The 53-week heatmap is ~745 px and does not
    // shrink: 880 − 64 (page px-8) − 40 (card px-5) = 776 px of inner width,
    // i.e. 31 px of headroom. Below 880 the heatmap's own overflow-x wrapper
    // starts scrolling, which is the intended behaviour — the page body never
    // scrolls horizontally.
    minWidth: 880,
    minHeight: 620,
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

  await load(dashboard, "/");
  return dashboard;
}

export async function showOnboarding(backgroundColor = "#FFFFFF"): Promise<BrowserWindow> {
  if (onboarding && !onboarding.isDestroyed()) {
    onboarding.show();
    onboarding.focus();
    return onboarding;
  }
  onboarding = new BrowserWindow({
    width: 560,
    height: 640,
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
  await load(onboarding, "/onboarding");
  return onboarding;
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
