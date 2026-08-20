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
