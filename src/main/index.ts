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
import { createCloudSetupGateway } from "./cloud-setup";
import { disposeIpc, pushAll, pushToAllWindows, registerIpcHandlers } from "./ipc";
import { log, logToDirectory } from "./log";
import { watchMainThread, type StallWatch } from "./stall";
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
/** Replaced in `whenReady`; the no-op keeps every `mark()` call unconditional. */
let stall: StallWatch = { mark: () => undefined, stop: () => undefined, worstMs: () => 0 };

app.whenReady().then(async () => {
  // FIRST, before anything that can hang. `userData` is settled by now (the
  // name is set at module scope and the smoke run has already claimed its
  // throwaway profile), and from here every boot step leaves a line on disk.
  // A boot that dies or freezes now ends its log at the step that did it —
  // which is the entire difference between "zero windows, empty stderr" and a
  // diagnosis. See src/main/log.ts.
  logToDirectory(app.getPath("userData"));
  log.boot(`ready · mode=${mode.kind} · packaged=${String(app.isPackaged)} · v${app.getVersion()}`);
  // Armed before anything that could hold the thread. It cannot log DURING a
  // freeze — nothing can — but it names the duration and the step the instant
  // one ends, which is how a freeze that resolves stops being invisible.
  stall = watchMainThread();
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
    // ── THE EXIT-CODE CONTRACT ───────────────────────────────────────────────
    // `--doctor` is a DUMP, not a verdict. It exits 0 whenever it managed to
    // produce a report, however red that report is; only a failure to produce
    // one is non-zero, and that path leaves nothing on stdout.
    //
    // It used to exit `allGreen ? 0 : 1`, which made a perfectly good report
    // indistinguishable from a missing app: `scripts/doctor.ts` saw a non-zero
    // exec, threw the report away, and printed "could not obtain a report — is
    // the app installed?" on every single install. Two processes were encoding
    // the same verdict and only one of them had the thresholds.
    //
    // So the thresholds live in exactly one place. `scripts/doctor.ts` owns
    // fail-vs-warn (exit 1 when an invariant is red, 2 when no report could be
    // obtained at all); this process owns "here is what I know". The script
    // also reads stdout even on a non-zero exit, so an older bundle installed
    // beside a newer checkout still reports rather than lying.
    app.exit(0);
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

  // The launch sync cycle — flush, pull, heartbeat, weekly export — used to
  // start here. It does not any more: it runs in `afterBoot()` at the bottom of
  // this file, once the tray and any window are already up.
  //
  // Not caution, arithmetic. Every one of its steps is either slow by nature
  // (network) or capable of stopping dead on something only a human can answer
  // (the Keychain, a TCC prompt on iCloud Drive). None of it is needed for the
  // app to measure hours, and the weekly export is a WEEKLY job that was
  // holding up EVERY launch.

  registerIpcHandlers(runtime, {
    settings,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    openPrivacyPane: (which) => void shell.openExternal(privacyPaneUrl(which)),
    syncConfig: services.syncConfig,
    // Everything `npm run bringup:cloud` does, over the Cloudflare REST API and
    // from the Settings window. It reuses `services.syncConfig.write` for the
    // last step, so finishing setup is the same event as pasting a URL and a
    // token by hand — including reconfiguring the flusher with no relaunch.
    cloudSetup: createCloudSetupGateway({
      machineId: services.machineId,
      syncConfig: services.syncConfig,
      onProgress: (progress) =>
        pushAll("wwb:push:cloud-setup", {
          steps: progress.steps.map((s) => ({ ...s })),
          done: progress.done,
          error: progress.error,
        }),
    }),
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

  log.boot("boot complete — the app is usable from here");
  stall.mark("running");
  afterBoot(services);
}).catch((err: unknown) => {
  // A boot that fails halfway leaves a menu-bar app that measures nothing and
  // says nothing. Say something, then exit non-zero so a LaunchAgent restart
  // is a restart rather than a zombie.
  log.error("boot failed", err);
  // NO MODAL IN A CLI MODE. `showErrorBox` holds the main thread until somebody
  // dismisses it, and `--doctor`/`--selftest`/`--smoke` are run by scripts —
  // `install.sh` runs both — with nobody watching the screen. A box here turns
  // "the doctor failed" into "the install hung", which is the same class of
  // freeze this file's `afterBoot()` exists to prevent. The log line above and
  // the non-zero exit below are what a script can actually act on.
  if (mode.kind === "normal") {
    dialog.showErrorBox(
      APP_NAME,
      `Work Week Buddy could not start:\n${String(err)}\n\nFull log: ${join(app.getPath("userData"), "wwb.log")}`,
    );
  }
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

/**
 * EVERYTHING THAT MAY BLOCK, AFTER THERE IS SOMETHING TO BLOCK IN FRONT OF.
 *
 * Two releases in a row froze on boot, and both froze on the same shape of
 * call: a synchronous macOS API that puts a dialog on screen and holds the
 * calling thread until somebody answers it. First `readdirSync` on iCloud Drive
 * behind a TCC prompt; then `safeStorage.decryptString()` behind a Keychain
 * prompt, which an ad-hoc signed rebuild earns on every single launch because
 * its code identity changes every time.
 *
 * A dialog is not the problem. A dialog in front of a running app is a question
 * the owner can answer. The problem was WHEN: before the tray existed, before
 * any window existed, with an `LSUIElement` app that cannot come to the front —
 * so the prompt sat behind other windows and the app looked dead, silently.
 *
 * So the rule this function exists to enforce: NOTHING THAT CAN PROMPT RUNS
 * BEFORE THE APP IS ON SCREEN. Both known offenders live here now, in order,
 * and each one says how long it took — because "the keychain took 40 seconds"
 * is a sentence that explains everything and "it hung" is not.
 */
function afterBoot(services: Awaited<ReturnType<typeof createCoreServices>>): void {
  // A tick, not a timer: `whenReady`'s continuation is still on the stack and
  // the first paint has not happened yet. One turn of the loop is all it takes
  // for the tray and the window to be real.
  setImmediate(() => {
    void (async () => {
      try {
        stall.mark("reading the sync token from the keychain");
        log.info(
          "reading the sync token — if the keychain asks, answer it: this call " +
            "holds the main thread until you do. The app is already up and its " +
            "windows are open, which is the whole reason this runs here and not " +
            "during boot.",
        );
        const unlocked = await services.unlockSync();
        if (unlocked.tookMs >= 2_000) {
          // Loud on purpose. This is the exact call that froze the last
          // release, and a slow one here is the same thing happening earlier.
          log.warn(
            `the keychain took ${String(unlocked.tookMs)}ms — that is a dialog somebody ` +
              `answered. It no longer runs during boot; see src/main/bootstrap.ts.`,
          );
        }
        log.info(
          `sync ${unlocked.configured ? "configured" : "not configured"}` +
            (unlocked.error === null ? "" : ` (${unlocked.error})`),
        );
      } catch (err) {
        log.error("resolving the sync configuration failed", err);
      } finally {
        stall.mark("running");
      }

      // Flush, pull, heartbeat, then the weekly export. Off the boot path for
      // the same reason: the export writes into iCloud Drive, which is TCC
      // protected, and a weekly job has no business gating every launch.
      try {
        stall.mark("the launch sync cycle");
        await services.sync.runCycle("launch");
      } catch (err) {
        log.error("the launch sync cycle failed", err);
      } finally {
        stall.mark("running");
      }
    })();
  });
}

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  dialog.showErrorBox(APP_NAME, `Unexpected error:\n${String(err)}`);
});
