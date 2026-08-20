import { app, Tray, Menu, nativeImage } from "electron";
import { APP_NAME } from "../shared/constants";

let tray: Tray | null = null;

/**
 * `--selftest`: install the real event tap, post one stamped jiggle, assert the
 * tap identified it as ours, print JSON, exit. No tray, no window, no single-
 * instance lock — it must be runnable while the app is already running.
 *
 * This is the hard gate in install.sh. If it fails, our own synthetic input
 * would be counted as human input and hours would inflate with fake time,
 * silently. See src/native/selftest-cli.ts.
 */
const SELFTEST = process.argv.includes("--selftest");

/**
 * Menu-bar only. No Dock icon, no app-switcher entry.
 * LSUIElement in electron-builder.yml covers the packaged app; this covers
 * `electron-vite dev`, where Info.plist does not apply.
 */
if (process.platform === "darwin") {
  app.dock?.hide();
}

// Two processes both writing one SQLite file and both holding an event tap is
// a corruption you would not notice for weeks.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  if (SELFTEST) {
    const { runSelfTestCli } = await import("../native/selftest-cli");
    app.exit(await runSelfTestCli());
    return;
  }
  // An empty image plus a title: the menu bar shows text, and there is no
  // binary asset to keep in sync.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("—h");
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${APP_NAME} — not yet tracking`, enabled: false },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]),
  );
});

// Tracking continues with no window open, so the app must not quit when the
// last window closes. On macOS that is the default, but it is stated here
// because it is load-bearing rather than incidental.
app.on("window-all-closed", () => {
  // intentionally empty
});
