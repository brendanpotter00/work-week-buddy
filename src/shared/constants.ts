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
