/**
 * Every magic value in one place. Nothing here is a preference.
 */

/**
 * Stamped on our own synthetic events so the event tap can identify and drop
 * them. Read back from field 42 (kCGEventSourceUserData) and corroborated by
 * the source pid. Two independent discriminators, measured clean across 422
 * events on macOS 26.5.1. See docs/MACOS.md section 2.
 */
export const WWB_MAGIC = 0x57574b31;

export const BUNDLE_ID = "com.bpotter.workweekbuddy";
export const APP_NAME = "Work Week Buddy";

/**
 * THE WINDOW→VIEW SEAM. One bundle serves both windows and the loaded path is
 * the only thing that tells them apart: `src/main/windows.ts` loads these,
 * `src/renderer/lib/route.ts` matches on them, and for one release nothing
 * did the matching — the 560x640 onboarding window rendered the whole
 * dashboard. Both halves read these constants so a typo cannot separate them
 * again.
 *
 * They are HASH paths (`index.html#/onboarding`). `app://` serves a file tree
 * with no server to map a real path onto index.html, and a hash is identical
 * in dev and in the packaged bundle.
 */
export const ROUTE = {
  dashboard: "/",
  onboarding: "/onboarding",
  /**
   * Settings is a THIRD WINDOW rather than a panel on the dashboard, for the
   * same reason onboarding is: the tray is where this app lives, and a tray
   * item that has to open the 1100-px dashboard first to reach a text field is
   * a tray item nobody uses. It is also the only shape in which "reachable from
   * both the dashboard and the tray" needs no extra state — both callers just
   * load this hash.
   */
  settings: "/settings",
} as const;

/**
 * The two windows, as numbers both `src/main/windows.ts` and the launched-app
 * smoke run read. They were inline in `windows.ts` while nothing checked them;
 * a window whose size is asserted somewhere else needs one definition.
 *
 * 880 is not a round number. The 53-week heatmap is ~745 px and does not
 * shrink: 880 - 64 (page px-8) - 40 (card px-5) = 776 px of inner width, i.e.
 * 31 px of headroom. Below 880 the heatmap's own overflow-x wrapper starts
 * scrolling, which is the intended behaviour - the page body never scrolls
 * horizontally.
 *
 * 560 x 640 fixed is the ONBOARDING box, and it is a promise: that window is
 * `resizable: false`, so anything that does not fit in it cannot be reached.
 * `src/renderer/Onboarding.tsx` is sized for exactly this rectangle.
 */
export const WINDOW_SIZE = {
  dashboard: { width: 1100, height: 860, minWidth: 880, minHeight: 620 },
  onboarding: { width: 560, height: 640 },
  /**
   * Settings is RESIZABLE, unlike onboarding. It holds two editable lists whose
   * length is the user's business, so a fixed box would be a promise this
   * window cannot keep — and `minHeight` is what stops it being dragged down to
   * a size where the sync form is unreachable.
   */
  settings: { width: 680, height: 820, minWidth: 560, minHeight: 520 },
} as const;

/** The three windows, by the name both halves of the app call them. */
export type AppWindow = keyof typeof WINDOW_SIZE;

/**
 * WHERE MACOS FLOATS THE TRAFFIC LIGHTS, and therefore where the title bar has
 * to start.
 *
 * All three windows are `titleBarStyle: "hiddenInset"`, which means there is no
 * chrome: the web contents fill the window right up to the top edge and macOS
 * draws the three buttons on top of them at this offset. Nothing else marks the
 * title bar — so if the renderer does not put a drag region up there, the strip
 * a person reaches for to move the window does nothing at all. That was the
 * bug: the dashboard's drag region started 40 px down and 32 px in, because it
 * was the `<header>` inside the centred content column rather than a bar across
 * the window.
 *
 * `src/main/windows.ts` spreads these into `trafficLightPosition` and
 * `src/renderer/components/title-bar.tsx` reads them back, so the two cannot
 * drift into a title bar that covers the buttons or a title that starts under
 * them.
 */
export const TRAFFIC_LIGHT = {
  dashboard: { x: 18, y: 18 },
  onboarding: { x: 14, y: 14 },
  settings: { x: 14, y: 14 },
} as const satisfies Record<AppWindow, { x: number; y: number }>;

/**
 * How tall a macOS window button is, measured from `trafficLightPosition.y`.
 *
 * 12 px of circle in a 14 px box. Rounded UP on purpose: the title bar's job is
 * to be at least this tall, and being a pixel generous costs nothing while
 * being a pixel short puts the window title through the close button.
 */
export const TRAFFIC_LIGHT_HEIGHT = 14;

/**
 * The blank strip each title bar keeps above its own first line of text.
 *
 * Every one of these is what that window's header already had — the dashboard's
 * `py-10`, the other two's `pt-8` — so making the header a real title bar moved
 * nothing on screen. That matters most for onboarding, which is a fixed
 * 560 × 640 box nobody can resize and which `src/main/smoke.ts` measures with
 * 16 px of required headroom.
 *
 * Each must clear its own traffic lights; `test/renderer/title-bar.test.tsx`
 * asserts exactly that against `TRAFFIC_LIGHT` above.
 */
export const TITLE_BAR_INSET = {
  dashboard: 40,
  onboarding: 32,
  settings: 32,
} as const satisfies Record<AppWindow, number>;

/** Initial values for the settings rows. All are user-changeable later. */
export const DEFAULTS = {
  idleTimeoutMs: 15 * 60_000,
  minIntervalMs: 90_000,
  cameraOnlyMaxMs: 6 * 60 * 60_000,
  micMinCaptureMs: 60_000,
  jigglerIntervalMs: 30_000,
  /** The EXPENSIVE half of the watchdog: camera, mic, granted mask. */
  watchdogMs: 5 * 60_000,
  /**
   * The CHEAP half: one `CGEventTapIsEnabled` read, and a re-arm if it says no.
   *
   * macOS never tells you promptly that it has disabled your tap — measured,
   * the notice waits for the next event, which is the very thing you have gone
   * blind to. So this is the clock that actually catches a dead tap, and its
   * period is the worst-case amount of work that can vanish without a trace.
   * Two seconds is small enough that the interval is not worth closing over;
   * five minutes was large enough to make every stored session a fragment.
   *
   * It is still ONE timer, not a second one: the same interval does the cheap
   * read every beat and the expensive probe every `watchdogMs`. Measured cost
   * of the cheap read on this Mac: `CGEventTapIsEnabled` is 15.6 µs, so 43,200
   * calls a day come to 0.67 s of CPU. That is what catching a dead tap in two
   * seconds instead of five minutes costs.
   */
  tapLivenessMs: 2_000,
  trayRefreshMs: 60_000,
  /** 1 = Monday. A work week's week is a work week. */
  weekStart: 1,
  /** PRD D1 = (a): time with our jiggler running does not count. */
  countJigglerTime: false,
  heatmapThresholdsH: [3, 6, 8],
} as const;
