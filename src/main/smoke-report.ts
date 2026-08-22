/**
 * What "the app actually works" means, as data — `docs/IMPL_UI.md` §7.3.
 *
 * A dashboard crammed into the 560 × 640 onboarding window shipped past a green
 * suite of 708 tests, because every one of them tested a component in a jsdom
 * with no window, no size and no URL. The hole was not a missing assertion in
 * any of those files: it was that nothing ever LAUNCHED THE APP AND LOOKED.
 *
 * `src/main/smoke.ts` launches it, opens both windows for real, measures them,
 * and hands the numbers to `checkSmokeReport()` below. This half is pure — no
 * electron, no DOM — so the rules are unit-tested on every platform, including
 * the Linux CI job that cannot run a window at all, and the launched run on
 * macOS is what produces the input.
 *
 * The three symptoms the owner reported map to three checks:
 *
 *  1. "the whole dashboard is in the little window"  → `view` must match the
 *     window the main process opened.
 *  2. "why is it so squishy"                          → `scrollWidth` may never
 *     exceed the viewport: the page body does not scroll sideways, per window.
 *  3. "why can't I resize it"                          → the onboarding window
 *     is `resizable: false` BY DESIGN, so its content has to fit 560 × 640
 *     without scrolling. That is an assertion, not a hope.
 */
import { WINDOW_SIZE } from "../shared/constants";

/**
 * The smoke run gets a throwaway `userData` directory under the system temp
 * dir, never the real profile: it opens a database, writes settings and toggles
 * the jiggler. `index.ts` mints the directory before `whenReady()` and
 * `runSmoke()` refuses to open anything unless the path it was handed carries
 * this prefix — one constant so the claim and the check cannot drift.
 */
export const SMOKE_PROFILE_PREFIX = "wwb-smoke-";

/**
 * The verdict file a packaged run leaves in `WWB_SMOKE_DIR`.
 *
 * A packaged run is started through LaunchServices, which hands the caller a
 * detached process and no exit code at all. `tools/smoke-packaged.sh` waits for
 * this file; its ABSENCE inside the timeout is itself a failure, and it is the
 * one that catches a main thread frozen on boot.
 */
export const RESULT_FILENAME = "result.json";

/**
 * The worst a 250 ms timer may be late before the main thread counts as stalled.
 *
 * Generous on purpose: `capturePage()` and six screenshots are real work, and a
 * loaded CI runner is slower than a desk. It is not tuned to catch the freeze
 * that shipped — that one blocked forever, and forever is caught by the run
 * never finishing. This catches its smaller relatives, the synchronous call on
 * the boot path that is merely slow today.
 */
export const MAX_STALL_MS = 3_000;

/**
 * Spelled the way `data-view` spells it, because the routing check is
 * `p.view === p.window` and that identity is the whole point of the probe.
 */
export type SmokeWindow = "dashboard" | "onboarding" | "cloud-setup";

/**
 * Two passes over the same two windows, plus one over the wizard.
 *
 * `degraded` is the state a fresh install is really in — Input Monitoring
 * granted but the running tap has no keyboard bits, Accessibility never
 * granted. It renders the tallest onboarding screen there is (relaunch banner +
 * both panes unresolved), which is the one that has to fit.
 *
 * `granted` is the same windows after main pushes a new permission snapshot,
 * with nothing reloaded. It proves the push channel reaches the view.
 */
export type SmokeScenario = "degraded" | "granted";

export interface JigglerProbe {
  present: boolean;
  disabled: boolean;
  checked: boolean;
}

export interface WindowProbe {
  window: SmokeWindow;
  scenario: SmokeScenario;
  /** `data-view` on the mounted root: what the RENDERER decided it is. */
  view: string | null;
  /** `BrowserWindow.getBounds()` — what macOS actually gave us. */
  bounds: { width: number; height: number };
  resizable: boolean;
  innerWidth: number;
  innerHeight: number;
  /** `documentElement.scrollWidth/Height`: the page body's own overflow. */
  scrollWidth: number;
  scrollHeight: number;
  /**
   * The one region allowed to scroll in the onboarding window. If it is
   * scrolling, the copy has outgrown a window nobody can resize.
   *
   * `contentHeight` is what the panes actually use, which `scrollHeight` cannot
   * tell you once everything fits — it clamps to `clientHeight` and reports a
   * screen with 4 px to spare identically to one with 80. The difference is the
   * whole margin the next paragraph of copy has to live in.
   */
  innerScroll: { clientHeight: number; scrollHeight: number; contentHeight: number } | null;
  /** Diagnostic only — names the offender when something IS too wide. */
  widest: { tag: string; className: string; width: number } | null;
  headings: string[];
  text: string;
  jiggler: JigglerProbe | null;
}

/** The click, and what it reached. A DOM that flipped alone proves nothing. */
export interface JigglerClickProbe {
  /** the switch reported itself checked afterwards */
  switchChecked: boolean;
  /** …and main's runtime agrees, which is the half that matters */
  runtimeJiggler: boolean;
  error: string | null;
}

export interface SmokeReport {
  ranAtMs: number;
  appVersion: string;
  /** True when this ran inside the signed `.app`, false for `electron .`. */
  packaged: boolean;
  /**
   * Worst main-thread stall observed during the run, in ms.
   *
   * The packaged app once booted with its main thread blocked in a synchronous
   * `readdirSync` waiting on a macOS consent prompt — no windows, no logs, no
   * `second-instance`, forever. This is the number that says the event loop
   * kept running (`src/main/file-access.ts`).
   */
  maxStallMs: number;
  probes: WindowProbe[];
  jigglerClick: JigglerClickProbe | null;
  /** Written only when WWB_SMOKE_DIR is set. Paths, for a human to open. */
  screenshots: string[];
}

/** Sub-pixel layout rounds; 1 px of slack is not a squished window. */
const SLACK = 1;

/**
 * One line of `text-xs` (16 px), rounded up. The onboarding panes must fit
 * their region with at least this much left over: "it happens to fit on this
 * machine" is not the same claim as "it fits", and the difference between them
 * is a font-metric change nobody will connect to the clipped button.
 */
const HEADROOM = 16;

const EXPECTED: ReadonlyArray<{ window: SmokeWindow; scenario: SmokeScenario }> = [
  { window: "dashboard", scenario: "degraded" },
  { window: "onboarding", scenario: "degraded" },
  { window: "dashboard", scenario: "granted" },
  { window: "onboarding", scenario: "granted" },
  // The fourth window, measured once. A window nothing measures is the exact
  // bug `Root.tsx` was written for — it renders the dashboard and nobody knows.
  { window: "cloud-setup", scenario: "degraded" },
];

function find(
  r: SmokeReport,
  window: SmokeWindow,
  scenario: SmokeScenario,
): WindowProbe | undefined {
  return r.probes.find((p) => p.window === window && p.scenario === scenario);
}

/**
 * Every failure, in words a person can act on. Empty means the app is fine.
 *
 * Deliberately returns ALL of them rather than throwing on the first: when the
 * routing is wrong every window is wrong, and seeing that is the diagnosis.
 */
export function checkSmokeReport(report: SmokeReport): string[] {
  const fail: string[] = [];

  // The main thread is the whole app: the tray, the IPC, every window and every
  // timer are on it. A stall here is not slowness, it is the app being gone.
  if (report.maxStallMs > MAX_STALL_MS) {
    fail.push(
      `the main thread stalled for ${report.maxStallMs}ms during the run (limit ${MAX_STALL_MS}ms). ` +
        `Something on the main thread is doing blocking I/O — see src/main/file-access.ts.`,
    );
  }

  for (const { window, scenario } of EXPECTED) {
    if (!find(report, window, scenario)) {
      fail.push(`no probe for the ${window} window in the ${scenario} scenario`);
    }
  }

  for (const p of report.probes) {
    const where = `${p.window} window (${p.scenario})`;

    // 1. THE BUG. The window main opened and the view the renderer mounted
    //    have to be the same thing.
    if (p.view !== p.window) {
      fail.push(
        `${where} rendered view "${p.view ?? "none"}" — the main process opened it as the ${p.window}. ` +
          `That is the routing seam: src/main/windows.ts loads the hash, src/renderer/lib/route.ts reads it.`,
      );
    }

    // 2. THE SQUISH. Content wider than the viewport means the page body
    //    scrolls sideways, which it may never do in either window.
    if (p.scrollWidth > p.innerWidth + SLACK) {
      const widest = p.widest ? ` widest element: <${p.widest.tag}> ${p.widest.width}px` : "";
      fail.push(
        `${where} has content ${p.scrollWidth}px wide in a ${p.innerWidth}px viewport.${widest}`,
      );
    }

    if (p.window === "dashboard") {
      // A dashboard narrower than its own minimum is the reported symptom
      // measured from the other side: the heatmap alone is ~745px.
      if (p.bounds.width < WINDOW_SIZE.dashboard.minWidth) {
        fail.push(
          `${where} is ${p.bounds.width}px wide; minWidth is ${WINDOW_SIZE.dashboard.minWidth}px.`,
        );
      }
      if (!p.text.includes("This week")) {
        fail.push(`${where} shows no "This week" card — this is not the dashboard.`);
      }
    }

    if (p.window === "cloud-setup") {
      // Resizable, so height is not a hard promise the way onboarding's is —
      // but the wizard must still open on its own first screen rather than on
      // an empty box, and the wayfinding sentence is the fix for failure #1.
      if (p.bounds.width < WINDOW_SIZE.cloudSetup.minWidth) {
        fail.push(
          `${where} is ${p.bounds.width}px wide; minWidth is ${WINDOW_SIZE.cloudSetup.minWidth}px.`,
        );
      }
      if (!p.resizable) {
        fail.push(`${where} is not resizable; the wizard is deliberately not a fixed box.`);
      }
      for (const needed of ["Cloud sync", "Continue"]) {
        if (!p.text.includes(needed)) fail.push(`${where} never mentions "${needed}".`);
      }
    }

    if (p.window === "onboarding") {
      const want = WINDOW_SIZE.onboarding;
      if (p.bounds.width !== want.width || p.bounds.height !== want.height) {
        fail.push(
          `${where} is ${p.bounds.width}×${p.bounds.height}; the fixed onboarding box is ${want.width}×${want.height}.`,
        );
      }
      if (p.resizable) {
        fail.push(`${where} is resizable; onboarding is a fixed box and its content is sized for it.`);
      }
      // Fixed box, so "does not fit" has no escape hatch: not the page…
      if (p.scrollHeight > p.innerHeight + SLACK) {
        fail.push(
          `${where} needs ${p.scrollHeight}px of height in a ${p.innerHeight}px window that cannot be resized.`,
        );
      }
      // …and not the pane list either.
      if (p.innerScroll && p.innerScroll.scrollHeight > p.innerScroll.clientHeight + SLACK) {
        fail.push(
          `${where}: the permission panes overflow their region ` +
            `(${p.innerScroll.contentHeight}px of content in ${p.innerScroll.clientHeight}px).`,
        );
      } else if (p.innerScroll && p.innerScroll.clientHeight - p.innerScroll.contentHeight < HEADROOM) {
        // A screen that fits with nothing to spare is one font metric away from
        // not fitting, and the failure is invisible until someone with a
        // different macOS version opens it. Ask for a line's worth of room.
        fail.push(
          `${where}: the permission panes fit with only ` +
            `${p.innerScroll.clientHeight - p.innerScroll.contentHeight}px to spare ` +
            `(${p.innerScroll.contentHeight}px in ${p.innerScroll.clientHeight}px); ` +
            `${HEADROOM}px is the minimum, because this window cannot be resized.`,
        );
      }
      for (const needed of ["Input Monitoring", "Accessibility", "Done"]) {
        if (!p.text.includes(needed)) fail.push(`${where} never mentions "${needed}".`);
      }
      // The jiggler is the only thing Accessibility buys, and the owner has to
      // be able to reach it: present always, clickable exactly when granted.
      if (!p.jiggler?.present) {
        fail.push(`${where} has no mouse-jiggler switch.`);
      } else if (p.scenario === "granted" && p.jiggler.disabled) {
        fail.push(`${where}: Accessibility is granted but the jiggler switch is still disabled.`);
      } else if (p.scenario === "degraded" && !p.jiggler.disabled) {
        fail.push(
          `${where}: the jiggler switch is enabled without Accessibility — it would appear on and do nothing.`,
        );
      }
    }
  }

  // The relaunch case is the one the owner's install is in. It must be said
  // out loud, in the window, not only in a tray tooltip.
  const degradedOnboarding = find(report, "onboarding", "degraded");
  if (degradedOnboarding && !/restart/i.test(degradedOnboarding.text)) {
    fail.push(
      "the onboarding window says nothing about restarting while relaunchRequired is true — " +
        "macOS hands the event mask out at launch, so the grant does not take effect until then.",
    );
  }

  // A live grant has to reach an OPEN window: main pushes wwb:push:permissions
  // and nothing reloads the page.
  const grantedOnboarding = find(report, "onboarding", "granted");
  if (grantedOnboarding && /restart/i.test(grantedOnboarding.text)) {
    fail.push(
      "the onboarding window still demands a restart after the permission push — " +
        "the wwb:push:permissions channel is not reaching the view.",
    );
  }

  if (report.jigglerClick === null) {
    fail.push("the jiggler switch was never clicked; the smoke run proves nothing about it.");
  } else {
    const c = report.jigglerClick;
    if (c.error !== null) fail.push(`clicking the jiggler switch failed: ${c.error}`);
    if (!c.switchChecked) fail.push("the jiggler switch did not turn on when clicked.");
    if (!c.runtimeJiggler) {
      fail.push(
        "the jiggler switch turned on in the DOM but the runtime's jiggler is still off — " +
          "a switch that appears on and does nothing is the failure this app is built against.",
      );
    }
  }

  return fail;
}
