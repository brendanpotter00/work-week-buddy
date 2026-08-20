import { app, Tray, Menu, nativeImage } from "electron";
import { APP_NAME } from "../shared/constants";

let tray: Tray | null = null;

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
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(() => {
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
