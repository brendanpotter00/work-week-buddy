/**
 * The entry point — `docs/IMPL_UI.md` §1.1 / §1.3.
 *
 * This file is module-scope side effects, on purpose and in a specific order.
 * Everything that can be tested lives in `bootstrap.ts`; what remains here is
 * the ordering itself, which is load-bearing:
 *
 *   1. `app.setName()` before anything reads `userData` (which is derived from it)
 *   2. `registerSchemesAsPrivileged()` at MODULE SCOPE, before `whenReady()` —
 *      called after ready it is a silent no-op and every ESM import 404s
 *   3. the CLI mode, before the lock — `--selftest`/`--doctor` run beside a live
 *      instance and must not take it
 *   4. the single-instance lock, exiting with `app.exit(0)` and never
 *      `app.quit()`: `quit()` fires `before-quit`, which would close the
 *      RUNNING instance's interval from this doomed process
 */
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  powerMonitor,
  protocol,
  safeStorage,
  shell,
} from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { APP_NAME } from "../shared/constants";
import { SMOKE_PROFILE_PREFIX } from "./smoke-report";
import {
  createCoreServices,
  wirePowerMonitor,
  wireQuit,
  wireWindowLifecycle,
} from "./bootstrap";
import { readCliMode } from "./cli";
import { disposeIpc, pushAll, pushToAllWindows, registerIpcHandlers } from "./ipc";
import { log, logToDirectory } from "./log";
import { buildAppMenu } from "./menu";
import { privacyPaneUrl, shouldShowOnboarding, startPermissionPoll } from "./onboarding";
import { APP_SCHEME, registerAppProtocol } from "./protocol";
import { SettingsStore } from "./settings";
import { TrayController } from "./tray";
import {
  closeAllWindows,
  getOnboardingWindow,
  showDashboard,
  showOnboarding,
  showSettings,
} from "./windows";

app.setName(APP_NAME);

// 2. MUST be at module scope. `standard: true` gives app:// a real origin,
//    which is what ESM, the CSP and localStorage all need.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const mode = readCliMode(process.argv);

if (mode.kind === "smoke") {
  // A THROWAWAY PROFILE, claimed before whenReady() so Electron's own caches
  // land in it too. The smoke run opens a database, writes settings and toggles
  // the jiggler; it does none of that to the real profile. Inlined rather than
  // imported from ./smoke so the smoke module — which pulls in the fake signal
  // source — stays out of the shipped main bundle. `runSmoke()` re-checks the
  // path before it opens anything.
  //
  // A caller that already handed us a throwaway profile keeps it — that is how
  // `tools/smoke-packaged.sh` knows where to read `wwb.log` back from after a
  // LaunchServices launch, which returns no handle to the process at all. The
  // prefix is still required, so "keeps it" can never mean the real profile.
  if (!basename(app.getPath("userData")).startsWith(SMOKE_PROFILE_PREFIX)) {
    app.setPath("userData", mkdtempSync(join(tmpdir(), SMOKE_PROFILE_PREFIX)));
  }
}

// Menu-bar only: no Dock icon, no app-switcher entry. LSUIElement covers the
// packaged app; this covers `electron-vite dev`, where Info.plist does not apply.
// The smoke run is the exception: `capturePage()` needs windows that actually
// composite, and an accessory app's never become key.
if (process.platform === "darwin" && mode.kind !== "smoke") app.dock?.hide();

if (mode.kind === "normal") {
  // Two processes both writing one SQLite file and both holding an event tap is
  // a corruption you would not notice for weeks.
  if (!app.requestSingleInstanceLock()) app.exit(0);
  app.on("second-instance", () => {
    // The owner's way back in when the tray is the only thing on screen. It was
    // `void showDashboard()`, which means a rejection here went nowhere at all.
    log.info("second launch — showing the dashboard");
    showDashboard().catch((err: unknown) => log.error("second-instance could not show the dashboard", err));
  });
}

const settings = new SettingsStore(() => app.getPath("userData"));
let tray: TrayController | null = null;

app.whenReady().then(async () => {
  // FIRST, before anything that can hang. `userData` is settled by now (the
  // name is set at module scope and the smoke run has already claimed its
  // throwaway profile), and from here every boot step leaves a line on disk.
  // A boot that dies or freezes now ends its log at the step that did it —
  // which is the entire difference between "zero windows, empty stderr" and a
  // diagnosis. See src/main/log.ts.
  logToDirectory(app.getPath("userData"));
  log.boot(`ready · mode=${mode.kind} · packaged=${String(app.isPackaged)} · v${app.getVersion()}`);
  if (mode.kind === "selftest") {
    // The hard gate in scripts/install.sh. If this fails, our own synthetic
    // input would be counted as human input and hours would inflate with fake
    // time, silently.
    const { runSelfTestCli } = await import("../native/selftest-cli");
    app.exit(await runSelfTestCli());
    return;
  }

  if (mode.kind === "smoke") {
    // Launches both windows for real and measures them. `src/main/smoke.ts`
    // has the why; the short version is that the dashboard shipped crammed
    // into the onboarding window past 708 green tests, because nothing ever
    // opened a window and looked at it.
    const { runSmokeCli } = await import("./smoke");
    app.exit(await runSmokeCli());
    return;
  }

  await settings.load();
  log.boot("settings loaded");

  if (mode.kind === "doctor") {
    const services = await createCoreServices({
      userDataDir: app.getPath("userData"),
      settings,
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      vault: safeStorage,
      osVersion: process.getSystemVersion(),
    });
    const report = await services.runtime.doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.allGreen ? 0 : 1);
    return;
  }

  if (mode.kind === "install-launch-agent" || mode.kind === "uninstall-launch-agent") {
    log.warn(`${mode.kind} is not implemented in this build`);
    app.exit(1);
    return;
  }

  registerAppProtocol();
  log.boot("app:// protocol registered");
  buildAppMenu(
    () => void showDashboard(settings.get("windowBackground")),
    () => void showSettings(settings.get("windowBackground")),
  );

  const services = await createCoreServices({
    userDataDir: app.getPath("userData"),
    settings,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    vault: safeStorage,
    osVersion: process.getSystemVersion(),
  });
  log.boot("core services created");
  const runtime = services.runtime;
  await runtime.start();
  services.watchdog.start();
  log.boot("runtime and watchdog started");

  // Sync at launch: flush, pull, heartbeat, then the weekly maintenance pass.
  // `void`, deliberately — the tray must appear and tracking must be running
  // before any of this, and none of it can fail in a way that matters. An
  // unconfigured install runs the local weekly export here and nothing else.
  void services.sync.runCycle("launch");

  registerIpcHandlers(runtime, {
    settings,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    openPrivacyPane: (which) => void shell.openExternal(privacyPaneUrl(which)),
    syncConfig: services.syncConfig,
    renameMachine: async (raw) => (await services.naming.rename(raw)).label,
    relaunch: () => {
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
    },
    closeOnboarding: () => getOnboardingWindow()?.close(),
    showDashboard: () => showDashboard(settings.get("windowBackground")),
    showSettings: () => showSettings(settings.get("windowBackground")),
  });

  // The tray IS the app: it exists before any window and outlives every window.
  tray = new TrayController(runtime, {
    settings,
    isPackaged: app.isPackaged,
    showDashboard: () => void showDashboard(settings.get("windowBackground")),
    showOnboarding: () => void showOnboarding(settings.get("windowBackground")),
    showSettings: () => void showSettings(settings.get("windowBackground")),
    openPrivacyPane: (which) => void shell.openExternal(privacyPaneUrl(which)),
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
    askJigglerPause: async () => {
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
      });
      return { response, checkboxChecked };
    },
  });
  tray.refresh("boot");
  log.boot("tray up");

  // ONE subscription fans out to the tray and to every open window.
  runtime.on("change", (kind) => {
    tray?.onRuntimeChange(kind);
    pushToAllWindows(runtime, kind);
  });

  wireWindowLifecycle({
    app,
    hasWindows: () => BrowserWindow.getAllWindows().length > 0,
    showDashboard: () => void showDashboard(settings.get("windowBackground")),
  });
  wirePowerMonitor({ powerMonitor, runtime, tray, sync: services.sync });
  wireQuit({
    app,
    runtime,
    onBeforeExit: () => {
      disposeIpc();
      services.watchdog.stop();
      tray?.destroy();
      closeAllWindows();
    },
  });

  // First launch after a clean install says so immediately. A normal launch
  // opens no window at all.
  const perms = await runtime.refreshPermissions();
  const wantsOnboarding = shouldShowOnboarding(perms, settings.get("onboardingDismissed"));
  // Said out loud BOTH WAYS. "No window on launch" is the correct behaviour for
  // a tray app whose permissions are settled, and it is also exactly what a
  // broken build looks like. Only the log can tell those two apart.
  log.boot(
    wantsOnboarding
      ? "permissions incomplete — opening onboarding"
      : "permissions settled — tray only, no window on launch (this is normal)",
  );
  if (wantsOnboarding) {
    await showOnboarding(settings.get("windowBackground"));
    log.boot("onboarding window open");
    // 1 Hz TCC read, alive only while that window exists, hard stop at 45 s.
    // In MAIN because the onboarding window spends its life behind System
    // Settings and hidden renderer timers collapse (AGENTS.md trap #10).
    startPermissionPoll({
      isWindowOpen: () => getOnboardingWindow() !== null,
      read: () => runtime.permissions(),
      onChange: (snap) => {
        pushAll("wwb:push:permissions", snap);
        tray?.refresh("permissions");
      },
    });
  }
}).catch((err: unknown) => {
  // A boot that fails halfway leaves a menu-bar app that measures nothing and
  // says nothing. Say something, then exit non-zero so a LaunchAgent restart
  // is a restart rather than a zombie.
  log.error("boot failed", err);
  dialog.showErrorBox(
    APP_NAME,
    `Work Week Buddy could not start:\n${String(err)}\n\nFull log: ${join(app.getPath("userData"), "wwb.log")}`,
  );
  app.exit(1);
});

app.on("browser-window-created", () => {
  // Keep the app menu alive across window churn: an LSUIElement app that loses
  // its menu also loses ⌘C/⌘V, which reads as "Electron is broken".
  if (Menu.getApplicationMenu() === null) {
    buildAppMenu(
      () => void showDashboard(settings.get("windowBackground")),
      () => void showSettings(settings.get("windowBackground")),
    );
  }
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  dialog.showErrorBox(APP_NAME, `Unexpected error:\n${String(err)}`);
});
