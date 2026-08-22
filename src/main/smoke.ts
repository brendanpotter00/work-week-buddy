/**
 * THE RUN THAT LOOKS AT THE APP — `docs/IMPL_UI.md` §7.3.
 *
 * 708 unit tests were green while the entire dashboard rendered inside a
 * 560 × 640 window nobody could resize. Not one of them was wrong. Every one of
 * them mounted a component in a jsdom that has no window, no size, no URL and
 * no layout engine, so not one of them could have seen it. The hole was never a
 * missing assertion — it was that nothing ever LAUNCHED THE APP AND LOOKED.
 *
 * This file launches it. It boots the real runtime over a fake `SignalSource`,
 * opens both real windows through the real `showDashboard()` / `showOnboarding()`
 * over the real `app://` protocol, measures them from inside, and hands the
 * numbers to `checkSmokeReport()` in `smoke-report.ts` — which is pure, and
 * therefore unit-tested on every platform including the Linux job that cannot
 * open a window at all.
 *
 * IT RUNS AGAINST THE PACKAGED APP TOO — `tools/smoke-packaged.sh`.
 *
 * It used to run only the built bundle (`out/`), on the argument that
 * everything the routing bug lived in was byte-identical between the two. That
 * argument was wrong, and it cost a release: the packaged app booted, showed
 * its tray icon, opened its database and then had NO WINDOWS AT ALL, silently,
 * because the main thread was blocked on a macOS consent prompt that a
 * terminal launch never sees (`src/main/file-access.ts`). Nothing that runs
 * `electron .` from a shell could have caught it, and nothing did.
 *
 * So `src/native/index.ts` now has exactly one door: a PACKAGED build takes the
 * fake source when it was started with `--smoke` AND `WWB_FAKE_NATIVE=1` AND
 * `WWB_ALLOW_FAKE_IN_PACKAGED=1`. `tools/smoke-packaged.sh` launches the real
 * `.app` through LaunchServices — which is how the owner launches it, and the
 * only way the prompt appears at all — and reads the result back out of
 * `WWB_SMOKE_DIR`.
 *
 * LAUNCH IT AS `electron .`, NOT `electron out/main/index.js`. With a script
 * path, `app.getAppPath()` resolves to `out/main/` and `preloadPath()` looks
 * for `out/main/out/preload/index.js` — the preload never loads, `window.wwb`
 * is `undefined`, and every window renders empty (`docs/IMPL_UI.md` §1.10).
 * `electron .` reads `package.json`'s `main` and puts `getAppPath()` at the
 * project root, which is where the packaged app has it too.
 *
 * TWO SCENARIOS, ONE LAUNCH:
 *
 *  - `degraded` is the state a fresh install is really in — Input Monitoring
 *    granted in System Settings, the live tap missing its keyboard bits,
 *    Accessibility never granted. It renders the TALLEST onboarding screen
 *    there is (restart banner + both panes unresolved), which is the one that
 *    has to fit in a window that cannot be resized.
 *  - `granted` is the same two windows after main pushes a new permission
 *    snapshot, with nothing reloaded. It proves `wwb:push:permissions` reaches
 *    the view, and that the jiggler switch beside it becomes usable.
 */
import { app, nativeTheme, type BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { FakeSignalSource } from "../native/fake-source";
import { createCoreServices } from "./bootstrap";
import { pushToAllWindows, registerIpcHandlers } from "./ipc";
import { registerAppProtocol } from "./protocol";
import { SettingsStore } from "./settings";
import {
  RESULT_FILENAME,
  SMOKE_PROFILE_PREFIX,
  checkSmokeReport,
  type JigglerClickProbe,
  type SmokeReport,
  type SmokeScenario,
  type SmokeWindow,
  type WindowProbe,
} from "./smoke-report";
import { log } from "./log";
import { closeAllWindows, showCloudSetup, showDashboard, showOnboarding } from "./windows";

/** Everything is bounded. A run that hangs is a run that fails, not one that waits. */
const OVERALL_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How late a 250 ms timer got, at worst, over the whole run.
 *
 * The bug this exists for froze the main thread outright, and an outright
 * freeze is caught by the runner's timeout rather than by a number. This
 * catches the near miss: a synchronous call on the boot path that takes two
 * seconds on a cold cache today and forever on a slow volume tomorrow. Cheap
 * enough to leave on — one timer and one subtraction.
 */
function startStallMeter(everyMs = 250): () => number {
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - everyMs);
    last = now;
  }, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return Math.max(0, Math.round(worst));
  };
}

async function waitFor(what: string, ok: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > deadline) {
      const why = rendererErrors.length === 0 ? "" : `\n  ${rendererErrors.join("\n  ")}`;
      throw new Error(`timed out waiting for ${what}${why}`);
    }
    await sleep(100);
  }
}

/**
 * Runs INSIDE the page, so every number is the one the user's eyes get.
 *
 * `scrollWidth`/`scrollHeight` on `documentElement` are the page body's own
 * overflow — the "why is everything one word per line" symptom, as two integers.
 */
const PROBE_JS = `(() => {
  const de = document.documentElement;
  const root = document.querySelector('[data-view]');
  const panes = document.querySelector('[data-slot="onboarding-panes"]');
  const sw = document.querySelector('[data-slot="jiggler-row"] [data-slot="switch"]');
  let widest = null;
  for (const el of document.querySelectorAll('body *')) {
    const w = Math.round(el.getBoundingClientRect().width);
    if (w > window.innerWidth + 1 && (widest === null || w > widest.width)) {
      widest = {
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className : '',
        width: w,
      };
    }
  }
  return {
    view: root === null ? null : root.getAttribute('data-view'),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: de.scrollWidth,
    scrollHeight: de.scrollHeight,
    innerScroll: panes === null
      ? null
      : {
          clientHeight: panes.clientHeight,
          scrollHeight: panes.scrollHeight,
          // What the panes actually USE. scrollHeight clamps to clientHeight
          // once everything fits, so it cannot tell 4px of headroom from 80.
          contentHeight: (() => {
            const last = panes.lastElementChild;
            if (last === null) return 0;
            return Math.ceil(
              last.getBoundingClientRect().bottom -
                panes.getBoundingClientRect().top +
                panes.scrollTop,
            );
          })(),
        },
    widest,
    headings: Array.from(document.querySelectorAll('h1,h2')).map((h) => (h.textContent || '').trim()),
    text: document.body.innerText || document.body.textContent || '',
    jiggler: sw === null
      ? null
      : {
          present: true,
          disabled: sw.hasAttribute('disabled') || sw.getAttribute('aria-disabled') === 'true',
          checked: sw.getAttribute('aria-checked') === 'true',
        },
  };
})()`;

type RawProbe = Omit<WindowProbe, "window" | "scenario" | "bounds" | "resizable">;

async function probe(
  win: BrowserWindow,
  which: SmokeWindow,
  scenario: SmokeScenario,
): Promise<WindowProbe> {
  const raw = (await win.webContents.executeJavaScript(PROBE_JS, true)) as RawProbe;
  const b = win.getBounds();
  return {
    ...raw,
    window: which,
    scenario,
    bounds: { width: b.width, height: b.height },
    resizable: win.isResizable(),
  };
}

/**
 * A window that never mounts has to say WHY.
 *
 * The renderer's own errors are the diagnosis — a failed `app://` fetch, a CSP
 * refusal, a preload that did not load — and they are invisible from main
 * unless somebody is listening. A smoke run that can only report "timed out" is
 * the same silence this whole file exists to end.
 */
function watchConsole(win: Electron.BrowserWindow, label: string, into: string[]): void {
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") into.push(`[${label}] ${e.message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    into.push(`[${label}] did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on("preload-error", (_e, path, err) => {
    into.push(`[${label}] preload-error ${path} ${err.message}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    into.push(`[${label}] render-process-gone ${details.reason}`);
  });
}

const rendererErrors: string[] = [];

/**
 * Mounted AND populated: a probe taken mid-mount measures a page that does not
 * exist yet.
 *
 * Waits for A view, never for THE view. If the wrong one mounted, this returns
 * and lets the probe happen anyway — `checkSmokeReport()` then says "the
 * onboarding window rendered view dashboard" and names both sides of the seam,
 * which is a diagnosis. Insisting on the right view here would instead time out
 * and report "the onboarding window never mounted", which is not even true.
 */
async function waitForView(win: BrowserWindow, view: SmokeWindow): Promise<void> {
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  }
  let seen: string | null = null;
  await waitFor(`the ${view} window to mount any view`, async () => {
    seen = (await win.webContents.executeJavaScript(
      `(() => { const r = document.querySelector('[data-view]');
                return r === null ? null : r.getAttribute('data-view'); })()`,
      true,
    )) as string | null;
    return seen !== null;
  });
  if (seen !== view) {
    // Wrong view. Let it settle and go measure it: the report is the message.
    await sleep(500);
    return;
  }
  // The first frame is the skeleton; every number arrives over IPC one tick
  // later. Measuring the skeleton would measure a page that never ships.
  await waitFor(`the ${view} window to render "${POPULATED_MARKER[view]}"`, async () =>
    Boolean(
      await win.webContents.executeJavaScript(
        `(document.body.innerText || '').includes(${JSON.stringify(POPULATED_MARKER[view])})`,
        true,
      ),
    ),
  );
  // One more paint, so getBoundingClientRect() reflects the populated tree.
  await sleep(250);
}

/**
 * The string that proves a window is POPULATED, not merely mounted.
 *
 * A table rather than a ternary, because a ternary is how the fourth window got
 * added and then waited for onboarding's marker: `view === "dashboard" ? … : …`
 * silently gave `cloud-setup` a string it can never render, and the smoke run
 * timed out saying the window never rendered "Input Monitoring". A
 * `Record<SmokeWindow, …>` makes a fifth window a compile error instead.
 *
 * Each marker has to be something that only appears AFTER the first IPC
 * snapshot lands: the wizard renders nothing but its title bar until
 * `wwb:sync:config` comes back and decides which screen to open on, so "Cancel"
 * — which both of its entry screens carry — is the honest signal here.
 */
const POPULATED_MARKER: Record<SmokeWindow, string> = {
  dashboard: "This week",
  onboarding: "Input Monitoring",
  "cloud-setup": "Cancel",
};

async function screenshot(win: BrowserWindow, dir: string, name: string): Promise<string> {
  const image = await win.webContents.capturePage();
  const path = join(dir, `${name}.png`);
  writeFileSync(path, image.toPNG());
  return path;
}

/**
 * The whole run. Returns the process exit code: 0 clean, 1 for a failed
 * assertion, 2 for a run that could not complete.
 */
export async function runSmoke(): Promise<number> {
  const readStall = startStallMeter();
  const screenshots: string[] = [];
  const shotDir = process.env["WWB_SMOKE_DIR"] ?? null;
  if (shotDir !== null) mkdirSync(shotDir, { recursive: true });

  // Checked again HERE, before anything is opened. `index.ts` mints the
  // throwaway profile, but this is the file that writes to it, and the one
  // outcome that is not available is a smoke run against the owner's real data.
  const userDataDir = app.getPath("userData");
  if (!basename(userDataDir).startsWith(SMOKE_PROFILE_PREFIX)) {
    throw new Error(
      `refusing to smoke-test against ${userDataDir} — it is not a throwaway profile`,
    );
  }

  const settings = new SettingsStore(() => app.getPath("userData"));
  await settings.load();

  registerAppProtocol();

  const services = await createCoreServices({
    userDataDir,
    settings,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isSmokeRun: true,
    // Inside the throwaway profile. `runCycle("launch")` below runs the real
    // weekly export, and the owner's iCloud Drive is not a test fixture.
    backupDir: join(userDataDir, "backups"),
    // No keychain. A smoke run must not be able to reach a real secret, and an
    // absent vault is an honest state the sync layer already models. It is also
    // what keeps a PACKAGED smoke run from stopping on a login-keychain prompt,
    // which blocks exactly the way the TCC prompt in `file-access.ts` does.
    vault: null,
  });

  const source = services.source;
  if (!(source instanceof FakeSignalSource)) {
    throw new Error(
      app.isPackaged
        ? "the smoke run needs the fake signal source — a packaged build takes it only with " +
          "WWB_FAKE_NATIVE=1 and WWB_ALLOW_FAKE_IN_PACKAGED=1 (src/native/index.ts)"
        : "the smoke run needs the fake signal source — set WWB_FAKE_NATIVE=1",
    );
  }

  /** The two knobs that make the fake source tell the truth about a real install. */
  const setPermissions = (scenario: SmokeScenario): void => {
    const granted = scenario === "granted";
    // Input Monitoring granted in System Settings, but the RUNNING TAP has no
    // keyboard bits until the app is restarted. That gap is `relaunchRequired`,
    // and it is the state the owner's install was in.
    source.perms = {
      listenEvent: true,
      postEvent: granted,
      axTrusted: granted,
      listenEventAccess: "granted",
      // DENIED, not merely absent: the degraded scenario is modelled on the
      // owner's actual install, whose Accessibility row was auth_value = 0. It
      // is the state that must never render as "we will ask you" — there is no
      // prompt left to draw.
      postEventAccess: granted ? "granted" : "denied",
    };
    source.keyboardBits = granted;
  };

  setPermissions("degraded");
  await services.runtime.start();

  // THE SAME CALL `index.ts` MAKES AT BOOT, and the reason this file now runs
  // against the packaged app at all. Everything downstream of it — the weekly
  // export, and every synchronous filesystem call inside it — used to run on
  // the main thread with nothing watching. It is `void` here exactly as it is
  // there: a launch does not wait for it, and neither does this run. What both
  // require is that it cannot stop the windows from opening, which is what the
  // stall meter and this run's timeout are for.
  void services.sync.runCycle("launch");

  registerIpcHandlers(services.runtime, {
    settings,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    openPrivacyPane: () => undefined,
    relaunch: () => undefined,
    closeOnboarding: () => undefined,
    showDashboard: () => showDashboard(settings.get("windowBackground")),
  });
  // The same single fan-out `index.ts` wires. Without it a permission change in
  // main never reaches an open window, which is half of what this run checks.
  services.runtime.on("change", (kind) => pushToAllWindows(services.runtime, kind));

  // Attached BEFORE the first window exists: the errors worth having are the
  // ones thrown while the page is loading, and by the time `showDashboard()`
  // resolves they have already happened.
  app.on("browser-window-created", (_e, win) => watchConsole(win, "renderer", rendererErrors));

  const dashboard = await showDashboard(settings.get("windowBackground"));
  const onboarding = await showOnboarding(settings.get("windowBackground"));
  // The fourth window gets opened for real and measured like the others. It is
  // never opened on first run in production — cloud sync is optional — but a
  // window nothing measures is a window that can silently render the dashboard.
  const cloudSetup = await showCloudSetup(settings.get("windowBackground"));
  await waitForView(dashboard, "dashboard");
  await waitForView(onboarding, "onboarding");
  await waitForView(cloudSetup, "cloud-setup");

  const probes: WindowProbe[] = [
    await probe(dashboard, "dashboard", "degraded"),
    await probe(onboarding, "onboarding", "degraded"),
    await probe(cloudSetup, "cloud-setup", "degraded"),
  ];
  if (shotDir !== null) {
    screenshots.push(await screenshot(dashboard, shotDir, "dashboard-degraded"));
    screenshots.push(await screenshot(onboarding, shotDir, "onboarding-degraded"));
    screenshots.push(await screenshot(cloudSetup, shotDir, "cloud-setup-degraded"));
  }

  // ── the grant lands, and nothing reloads ────────────────────────────────
  setPermissions("granted");
  // The watchdog's own path into the runtime: a new NativeStatus re-reads the
  // permissions, which emits "permissions", which pushes to every open window.
  services.runtime.onWatchdogTick(source.probe(), Date.now());
  // Non-fatal on purpose. "The push never reached the view" is a rule the
  // checker already owns, and it says it far better than a stack trace does.
  await waitFor("the permission push to reach the onboarding window", async () =>
    Boolean(
      await onboarding.webContents.executeJavaScript(
        `!/restart/i.test(document.body.innerText || '')`,
        true,
      ),
    ),
  ).catch(() => undefined);
  await sleep(250);

  probes.push(await probe(dashboard, "dashboard", "granted"));
  probes.push(await probe(onboarding, "onboarding", "granted"));
  if (shotDir !== null) {
    screenshots.push(await screenshot(dashboard, shotDir, "dashboard-granted"));
    screenshots.push(await screenshot(onboarding, shotDir, "onboarding-granted"));
  }

  // ── the click, and what it reached ──────────────────────────────────────
  // A DOM that flipped alone proves nothing: the failure this app is built
  // against is a switch that turns on and does not do the thing.
  let jigglerClick: JigglerClickProbe | null = null;
  try {
    await onboarding.webContents.executeJavaScript(
      `document.querySelector('[data-slot="jiggler-row"] [data-slot="switch"]').click()`,
      true,
    );
    await waitFor("the jiggler to reach the runtime", async () =>
      services.runtime.toggles().jiggler,
    ).catch(() => undefined);
    const switchChecked = Boolean(
      await onboarding.webContents.executeJavaScript(
        `document.querySelector('[data-slot="jiggler-row"] [data-slot="switch"]')
           .getAttribute('aria-checked') === 'true'`,
        true,
      ),
    );
    jigglerClick = {
      switchChecked,
      runtimeJiggler: services.runtime.toggles().jiggler,
      error: null,
    };
  } catch (err) {
    jigglerClick = {
      switchChecked: false,
      runtimeJiggler: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── both palettes, for a human ──────────────────────────────────────────
  // Everything above ran in whatever theme the machine happens to be in, so on
  // its own it says nothing about the other one. `nativeTheme.themeSource` is
  // what `prefers-color-scheme` reads, which is what `ThemeProvider` follows on
  // its default "system" setting. Screenshots only — no assertion, because
  // "does this look right" is not a number.
  if (shotDir !== null) {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      screenshots.push(await screenshot(onboarding, shotDir, `onboarding-${theme}`));
      screenshots.push(await screenshot(dashboard, shotDir, `dashboard-${theme}`));
    }
    nativeTheme.themeSource = "system";
  }

  const report: SmokeReport = {
    ranAtMs: Date.now(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    maxStallMs: readStall(),
    probes,
    jigglerClick,
    screenshots,
  };

  const failures = checkSmokeReport(report);
  writeReport(report, failures);
  // The failures go in the JSON too. A CI artifact that carries the numbers but
  // not the verdict makes the reader re-derive it.
  if (shotDir !== null) {
    writeFileSync(
      join(shotDir, "smoke-report.json"),
      `${JSON.stringify({ ...report, failures }, null, 2)}\n`,
    );
  }

  // Turn the jiggler back off before stop(), so the run leaves no timer behind.
  await services.runtime.setToggle({ key: "jiggler", value: false, source: "dashboard" });
  await services.runtime.stop("app_quit");
  services.watchdog.stop();
  closeAllWindows();

  return failures.length === 0 ? 0 : 1;
}

/** Human first, JSON second: the point of this run is that somebody reads it. */
function writeReport(report: SmokeReport, failures: readonly string[]): void {
  const out = process.stdout;
  out.write("\n── smoke ──────────────────────────────────────────────────────\n");
  for (const p of report.probes) {
    out.write(
      `  ${p.window.padEnd(10)} ${p.scenario.padEnd(9)} view=${String(p.view).padEnd(11)} ` +
        `window=${p.bounds.width}x${p.bounds.height} viewport=${p.innerWidth}x${p.innerHeight} ` +
        `content=${p.scrollWidth}x${p.scrollHeight}` +
        (p.innerScroll === null
          ? ""
          : ` panes=${p.innerScroll.contentHeight}/${p.innerScroll.clientHeight}` +
            ` (${p.innerScroll.clientHeight - p.innerScroll.contentHeight}px spare)`) +
        "\n",
    );
  }
  if (report.jigglerClick !== null) {
    const c = report.jigglerClick;
    out.write(`  jiggler click → switch=${c.switchChecked} runtime=${c.runtimeJiggler}\n`);
  }
  out.write(
    `  packaged=${String(report.packaged)} worst main-thread stall=${String(report.maxStallMs)}ms\n`,
  );
  for (const path of report.screenshots) out.write(`  shot ${path}\n`);
  out.write("───────────────────────────────────────────────────────────────\n");
  if (failures.length === 0) {
    out.write("smoke: OK\n");
    return;
  }
  for (const f of failures) out.write(`smoke FAIL: ${f}\n`);
}

/**
 * The verdict, on disk.
 *
 * A packaged run is started by LaunchServices — `open -n`, exactly the way the
 * owner starts the app — and LaunchServices gives the caller no stdout and no
 * exit code. It gets a detached process and nothing else. So the run writes its
 * own verdict to `WWB_SMOKE_DIR/result.json`, and `tools/smoke-packaged.sh`
 * waits for the file. NO FILE IS ALSO AN ANSWER, and it is the one that matters
 * here: an app that froze on boot never writes it, and the runner fails on the
 * timeout with the boot log to explain why.
 */
function writeResult(exitCode: number, note: string): void {
  const dir = process.env["WWB_SMOKE_DIR"] ?? null;
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, RESULT_FILENAME),
      `${JSON.stringify({ exitCode, note, packaged: app.isPackaged, atMs: Date.now() }, null, 2)}\n`,
    );
  } catch (err) {
    process.stdout.write(`smoke: could not write result.json: ${String(err)}\n`);
  }
}

/**
 * The entry point `index.ts` calls. Never throws, always exits: an unhandled
 * rejection in here would hang the CI job rather than fail it.
 */
export async function runSmokeCli(): Promise<number> {
  const bomb = setTimeout(() => {
    process.stdout.write(`smoke FAIL: the run did not finish within ${OVERALL_TIMEOUT_MS}ms\n`);
    writeResult(2, `the run did not finish within ${OVERALL_TIMEOUT_MS}ms`);
    app.exit(2);
  }, OVERALL_TIMEOUT_MS);
  bomb.unref?.();
  try {
    const code = await runSmoke();
    writeResult(code, code === 0 ? "ok" : "assertions failed — see smoke-report.json");
    return code;
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stdout.write(`smoke FAIL: ${detail}\n`);
    log.error("smoke run could not complete", err);
    writeResult(2, detail);
    return 2;
  } finally {
    clearTimeout(bomb);
  }
}
