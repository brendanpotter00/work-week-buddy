/**
 * A `DoctorReport` in which every invariant is green, plus a shallow patcher.
 *
 * This is the whole reason `scripts/doctor.ts` splits `evaluate()` from
 * `collectReport()`: every red and green state below is produced from an object
 * literal, so the tests need no permissions, no event tap, no database, and no
 * installed bundle. Nothing here touches the machine.
 */
import type { DoctorReport, SelfTestResult } from "@/shared/ipc-types";

/** Fixed clock. 2026-08-19T12:00:00Z — the tests do arithmetic, never `Date.now()`. */
export const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const GREEN: DoctorReport = {
  generatedAtMs: NOW - 2_000,
  allGreen: true,
  app: {
    version: "0.1.0",
    electron: "43.4.1",
    bundleId: "com.bpotter.workweekbuddy",
    execPath: "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy",
    isPackaged: true,
    launchedAtMs: NOW - 6 * HOUR,
  },
  machine: { machineId: "m-1", label: "MacBook Pro", osVersion: "26.5.1", tz: "America/New_York" },
  permissions: {
    checkedAtMs: NOW - MINUTE,
    inputMonitoring: "granted",
    accessibility: "granted",
    keyboardBitsGranted: true,
    flagsChangedBitGranted: true,
    grantedMaskHex: "0x2000000000ca",
    relaunchRequired: false,
    promptConsumed: { inputMonitoring: true, accessibility: true },
    microphone: "not-required",
  },
  tap: {
    created: true,
    enabled: true,
    grantedMaskHex: "0x2000000000ca",
    keyboardBitsPresent: true,
    flagsChangedBitPresent: true,
    probed: true,
    runLoopModes: ["default", "common"],
    eventsSinceLaunch: 48_213,
    lastEventMs: NOW - 40_000,
    disabledByTimeoutCount: 0,
    disabledByUserInputCount: 0,
    reEnabledCount: 0,
    reEnableFailedCount: 0,
    revivedCount: 0,
    lastRevivalMs: null,
    lastRevivalOutcome: null,
    drainsOverdue: 0,
    worstDrainLagMs: 0,
    tapLostRows: 0,
    lastWatchdogTickMs: NOW - 2 * MINUTE,
  },
  camera: { probed: true, deviceCount: 2, inUse: false, lastReadMs: NOW - MINUTE },
  mic: { inUse: false },
  sync: {
    configured: true,
    pendingRows: 0,
    lastFlushOkMs: NOW - 40 * MINUTE,
    lastFlushError: null,
    lastPullMs: NOW - 40 * MINUTE,
    lastPullError: null,
    watermark: NOW - 40 * MINUTE,
    lastCloudWriteMs: NOW - 40 * MINUTE,
    silentForMs: 40 * MINUTE,
  },
  fingerprint: {
    checkedAtMs: NOW - 2 * DAY,
    matched: true,
    localCount: 1_204,
    cloudCount: 1_204,
    localSha: "a1b2c3",
    cloudSha: "a1b2c3",
  },
  backup: {
    lastPath: "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/wwb-2026-W34.sqlite",
    lastAtMs: NOW - 2 * DAY,
    ageDays: 2,
    destination: "icloud",
    kept: 34,
  },
  selfTest: {
    ranAtMs: NOW - 3 * DAY,
    passed: true,
    appVersion: "0.1.0",
    checks: [
      { id: "jiggle-tagged", passed: true, detail: "field 42 read back as 0x57574b31" },
      { id: "tap-alive", passed: true, detail: "mask 0x2000000000ca" },
    ],
  },
  db: {
    path: "/Users/x/Library/Application Support/Work Week Buddy/wwb.sqlite",
    sizeBytes: 3_407_872,
    rows: 1_204,
    openIntervalPresent: false,
    integrityOk: true,
  },
  autostart: {
    probed: true,
    installed: true,
    loaded: true,
    plistPath: "/Users/x/Library/LaunchAgents/com.bpotter.workweekbuddy.plist",
    execPath: "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy",
    execExists: true,
    execMatchesRunningApp: true,
  },
  codesign: { probed: true, designatedRequirementSha256: "deadbeef", valid: true },
};

type Section<T> = { [K in keyof T]?: T[K] };

export interface ReportPatch {
  generatedAtMs?: number;
  allGreen?: boolean;
  app?: Section<DoctorReport["app"]>;
  machine?: Section<DoctorReport["machine"]>;
  permissions?: Section<DoctorReport["permissions"]>;
  tap?: Section<DoctorReport["tap"]>;
  camera?: Section<DoctorReport["camera"]>;
  mic?: Section<DoctorReport["mic"]>;
  sync?: Section<DoctorReport["sync"]>;
  fingerprint?: Section<DoctorReport["fingerprint"]>;
  backup?: Section<DoctorReport["backup"]>;
  selfTest?: SelfTestResult | null;
  db?: Section<DoctorReport["db"]>;
  autostart?: Section<DoctorReport["autostart"]>;
  codesign?: Section<DoctorReport["codesign"]>;
}

/** GREEN with one section overridden. One red at a time is the point. */
export function report(patch: ReportPatch = {}): DoctorReport {
  return {
    ...GREEN,
    ...(patch.generatedAtMs === undefined ? {} : { generatedAtMs: patch.generatedAtMs }),
    ...(patch.allGreen === undefined ? {} : { allGreen: patch.allGreen }),
    ...(patch.selfTest === undefined ? {} : { selfTest: patch.selfTest }),
    app: { ...GREEN.app, ...patch.app },
    machine: { ...GREEN.machine, ...patch.machine },
    permissions: { ...GREEN.permissions, ...patch.permissions },
    tap: { ...GREEN.tap, ...patch.tap },
    camera: { ...GREEN.camera, ...patch.camera },
    mic: { ...GREEN.mic, ...patch.mic },
    sync: { ...GREEN.sync, ...patch.sync },
    fingerprint: { ...GREEN.fingerprint, ...patch.fingerprint },
    backup: { ...GREEN.backup, ...patch.backup },
    db: { ...GREEN.db, ...patch.db },
    autostart: { ...GREEN.autostart, ...patch.autostart },
    codesign: { ...GREEN.codesign, ...patch.codesign },
  };
}
