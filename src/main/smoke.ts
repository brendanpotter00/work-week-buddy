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
 * WHAT IT IS NOT. It runs the BUILT bundle (`out/`), not the signed `.app`.
 * That is deliberate rather than a shortcut: `src/native/index.ts` refuses the
 * fake source in a packaged build, on purpose, so a packaged smoke run would
 * need real Input Monitoring and Accessibility grants and could not run
 * unattended anywhere. Everything the routing bug lived in — the `app://`
 * protocol handler, the loaded URL, the renderer bundle, the window geometry —
 * is byte-identical between the two. `npm run package` is still the thing to
 * run by hand before a release; `scripts/doctor.ts` is what inspects the
 * installed copy.
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
  SMOKE_PROFILE_PREFIX,
  checkSmokeReport,
  type JigglerClickProbe,
  type SmokeReport,
  type SmokeScenario,
  type SmokeWindow,
  type WindowProbe,
} from "./smoke-report";
import { closeAllWindows, showDashboard, showOnboarding } from "./windows";

/** Everything is bounded. A run that hangs is a run that fails, not one that waits. */
const OVERALL_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const marker = view === "dashboard" ? "This week" : "Input Monitoring";
  await waitFor(`the ${view} window to render "${marker}"`, async () =>
    Boolean(
      await win.webContents.executeJavaScript(
        `(document.body.innerText || '').includes(${JSON.stringify(marker)})`,
        true,
      ),
    ),
  );
  // One more paint, so getBoundingClientRect() reflects the populated tree.
  await sleep(250);
}

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
    // No keychain. A smoke run must not be able to reach a real secret, and an
    // absent vault is an honest state the sync layer already models.
    vault: null,
  });

  const source = services.source;
  if (!(source instanceof FakeSignalSource)) {
    throw new Error(
      "the smoke run needs the fake signal source — set WWB_FAKE_NATIVE=1 and run an unpackaged build",
    );
  }

  /** The two knobs that make the fake source tell the truth about a real install. */
  const setPermissions = (scenario: SmokeScenario): void => {
    const granted = scenario === "granted";
    // Input Monitoring granted in System Settings, but the RUNNING TAP has no
    // keyboard bits until the app is restarted. That gap is `relaunchRequired`,
    // and it is the state the owner's install was in.
    source.perms = { listenEvent: true, postEvent: granted, axTrusted: granted };
    source.keyboardBits = granted;
  };

  setPermissions("degraded");
  await services.runtime.start();

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
  await waitForView(dashboard, "dashboard");
  await waitForView(onboarding, "onboarding");

  const probes: WindowProbe[] = [
    await probe(dashboard, "dashboard", "degraded"),
    await probe(onboarding, "onboarding", "degraded"),
  ];
  if (shotDir !== null) {
    screenshots.push(await screenshot(dashboard, shotDir, "dashboard-degraded"));
    screenshots.push(await screenshot(onboarding, shotDir, "onboarding-degraded"));
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
    probes,
    jigglerClick,
    screenshots,
  };

  if (shotDir !== null) {
    writeFileSync(join(shotDir, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }

  const failures = checkSmokeReport(report);
  writeReport(report, failures);

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
  for (const path of report.screenshots) out.write(`  shot ${path}\n`);
  out.write("───────────────────────────────────────────────────────────────\n");
  if (failures.length === 0) {
    out.write("smoke: OK\n");
    return;
  }
  for (const f of failures) out.write(`smoke FAIL: ${f}\n`);
}

/**
 * The entry point `index.ts` calls. Never throws, always exits: an unhandled
 * rejection in here would hang the CI job rather than fail it.
 */
export async function runSmokeCli(): Promise<number> {
  const bomb = setTimeout(() => {
    process.stdout.write(`smoke FAIL: the run did not finish within ${OVERALL_TIMEOUT_MS}ms\n`);
    app.exit(2);
  }, OVERALL_TIMEOUT_MS);
  bomb.unref?.();
  try {
    return await runSmoke();
  } catch (err) {
    process.stdout.write(`smoke FAIL: ${err instanceof Error ? err.stack : String(err)}\n`);
    return 2;
  } finally {
    clearTimeout(bomb);
  }
}
