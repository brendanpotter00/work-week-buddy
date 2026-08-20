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

/** Initial values for the settings rows. All are user-changeable later. */
export const DEFAULTS = {
  idleTimeoutMs: 15 * 60_000,
  minIntervalMs: 90_000,
  cameraOnlyMaxMs: 6 * 60 * 60_000,
  micMinCaptureMs: 60_000,
  jigglerIntervalMs: 30_000,
  watchdogMs: 5 * 60_000,
  trayRefreshMs: 60_000,
  /** 1 = Monday. A work week's week is a work week. */
  weekStart: 1,
  /** PRD D1 = (a): time with our jiggler running does not count. */
  countJigglerTime: false,
  heatmapThresholdsH: [3, 6, 8],
} as const;

/**
 * Bundle ids whose microphone use means "meeting" rather than "dictation".
 * The OS reports that the mic is captured but not by whom, so a running
 * meeting app is the available proxy. See docs/PRD.md section 3.5.
 */
export const MEETING_APPS = [
  "us.zoom.xos",
  "com.microsoft.teams2",
  "com.cisco.webexmeetingsapp",
  "com.tinyspeck.slackmacgap",
  "com.hnc.Discord",
] as const;

/** Mic holders that are never meetings. Seeded; user-editable. */
export const MIC_IGNORE = [
  "com.electron.wispr-flow",
  "com.gizmolabs.openwhispr",
] as const;
