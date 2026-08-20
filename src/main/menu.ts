/**
 * The application menu — `docs/IMPL_UI.md` §1.6.
 *
 * An `LSUIElement` app still activates and still shows its menu bar when a
 * window is key. WITHOUT a menu, ⌘C, ⌘V and ⌘A do not work in the dashboard —
 * a bug that reads as "Electron is broken".
 */
import { Menu, app } from "electron";

export function buildAppMenu(showDashboard: () => void, showSettings: () => void): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Open Dashboard", click: () => showDashboard() },
          // ⌘, is where every Mac user looks first, and it costs one line. The
          // tray item is still the one that matters — this menu only exists
          // while a window is key, and the app is usually all tray.
          { label: "Settings…", accelerator: "CommandOrControl+,", click: () => showSettings() },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { type: "separator" },
          // ⌘Q → before-quit → runtime.stop("app_quit")
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        // ⌘W closes the window; tracking continues.
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
    ]),
  );
}
