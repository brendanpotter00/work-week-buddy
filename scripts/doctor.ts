/**
 * `scripts/doctor.ts` — one line per invariant, non-zero exit if any is red.
 * docs/IMPL_LAYOUT.md §9.
 *
 * The app already knows everything: `--doctor` boots the runtime read-only,
 * without taking the single-instance lock, and prints a `DoctorReport` as JSON
 * (see `src/main/index.ts`). This script does exactly two things the app does
 * not: it applies a THRESHOLD to each field, and it turns the result into a
 * verdict a script can gate on.
 *
 * That split is why this file is testable. `evaluate()` is pure — a report and
 * a clock in, a list of invariants out — so every red and green state is proved
 * from an injected object with no permissions, no database, and no machine
 * access at all. Only `collectReport()` touches the Mac.
 *
 * Three states, not two:
 *   ok    the invariant holds
 *   warn  not yet known (never synced, never backed up, never self-tested).
 *         Does NOT fail the run: a freshly installed app has warned on half of
 *         these by construction, and a doctor that cries wolf on first launch
 *         is a doctor nobody runs again.
 *   fail  the invariant is broken. Exit code 1.
 *
 * Runs on the pinned Node (22.14.0) via type stripping, so it imports TYPES
 * only — a value import of `src/shared/format.ts` would need a file extension
 * Node wants and `tsc` rejects. The handful of formatters below are duplicated
 * for that reason and for no other; they are display-only and touch no rule.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { DoctorReport, PermissionState } from "../src/shared/ipc-types";

const run = promisify(execFile);

/** Frozen. TCC grants bind to bundle id + designated requirement + this path. */
export const APP_PATH = "/Applications/Work Week Buddy.app";
export const APP_BIN = `${APP_PATH}/Contents/MacOS/Work Week Buddy`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** DATA_MODEL.md backup layer 4: no cloud write in 72 h is an alarm. */
export const SYNC_SILENT_FAIL_MS = 72 * HOUR;
/** Backups are weekly. One missed week warns; two is a real failure. */
export const BACKUP_WARN_MS = 8 * DAY;
export const BACKUP_FAIL_MS = 15 * DAY;
/** A self-test older than this proves nothing about the build now installed. */
export const SELFTEST_STALE_MS = 30 * DAY;

export type Level = "ok" | "warn" | "fail";

export interface Invariant {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

// ── display helpers (no rules live here) ────────────────────────────────────

/** Local, never UTC: a UTC date silently moves every evening event a day on. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ── the invariants ──────────────────────────────────────────────────────────

function describePermission(state: PermissionState): string {
  switch (state) {
    case "granted":
      return "granted";
    case "denied":
      return "DENIED";
    case "undetermined":
      return "never prompted";
    default:
      return "unknown";
  }
}

function inputMonitoring(r: DoctorReport): Invariant {
  const state = r.permissions.inputMonitoring;
  const level: Level = state === "granted" ? "ok" : state === "unknown" ? "warn" : "fail";
  const why =
    state === "granted"
      ? ""
      : " — keyboard events never arrive, and nothing else reports their absence";
  return {
    id: "input-monitoring",
    label: "Input Monitoring",
    level,
    detail: `${describePermission(state)}${why}`,
  };
}

function accessibility(r: DoctorReport): Invariant {
  const state = r.permissions.accessibility;
  // Not a failure: Accessibility is the jiggler's permission. Without it the
  // jiggler cannot post, and tracking is entirely unaffected.
  return {
    id: "accessibility",
    label: "Accessibility",
    level: state === "granted" ? "ok" : "warn",
    detail:
      state === "granted"
        ? "granted (jiggler can post)"
        : `${describePermission(state)} — jiggler disabled; tracking unaffected`,
  };
}

function tapAlive(r: DoctorReport, nowMs: number): Invariant {
  const t = r.tap;
  const seen = `${count(t.eventsSinceLaunch)} events since launch`;
  if (!t.created) {
    return { id: "tap", label: "Event tap", level: "fail", detail: "not created" };
  }
  if (!t.enabled) {
    return {
      id: "tap",
      label: "Event tap",
      level: "fail",
      detail: `created but DISABLED by the system (${count(t.disabledByTimeoutCount)} timeout notices)`,
    };
  }
  if (t.tapLostRows > 0) {
    return {
      id: "tap",
      label: "Event tap",
      level: "warn",
      detail: `alive, ${seen}, but ${count(t.tapLostRows)} interval(s) closed as tap_lost`,
    };
  }
  const last = t.lastEventMs === null ? "no events yet" : `last ${ago(nowMs - t.lastEventMs)}`;
  return { id: "tap", label: "Event tap", level: "ok", detail: `alive, ${seen}, ${last}` };
}

function grantedMask(r: DoctorReport): Invariant {
  const p = r.permissions;
  const hex = p.grantedMaskHex || "(unread)";
  // MACOS.md §6: the preflights are not trusted. The mask read back off the
  // live tap is the authority, and it is the only thing that can prove the
  // keyboard bits actually arrived.
  if (p.relaunchRequired) {
    return {
      id: "granted-mask",
      label: "Granted mask",
      level: "fail",
      detail: `${hex} — a grant landed but this tap still lacks the bits; RELAUNCH required`,
    };
  }
  if (!p.keyboardBitsGranted || !p.flagsChangedBitGranted) {
    const missing = [
      p.keyboardBitsGranted ? null : "keyDown/keyUp",
      p.flagsChangedBitGranted ? null : "flagsChanged",
    ]
      .filter((x): x is string => x !== null)
      .join(" + ");
    // Missing keyboard bits is the silent one: mouse still flows, hours still
    // accrue, and a whole day of typing simply never registers.
    return {
      id: "granted-mask",
      label: "Granted mask",
      level: p.keyboardBitsGranted ? "warn" : "fail",
      detail: `${hex} — missing ${missing}`,
    };
  }
  return {
    id: "granted-mask",
    label: "Granted mask",
    level: "ok",
    detail: `${hex} (keyboard + flagsChanged present)`,
  };
}

function selfTest(r: DoctorReport, nowMs: number): Invariant {
  const s = r.selfTest;
  if (s === null) {
    return {
      id: "selftest",
      label: "Self-test",
      level: "warn",
      detail: "never run — run scripts/install.sh, or the app with --selftest",
    };
  }
  const when = `${stamp(s.ranAtMs)} (${ago(nowMs - s.ranAtMs)})`;
  if (!s.passed) {
    const failed = s.checks
      .filter((c) => !c.passed)
      .map((c) => c.id)
      .join(", ");
    // The self-test is what proves our own jiggle is distinguishable from human
    // input. Failing it means hours inflate with synthetic time, silently.
    return {
      id: "selftest",
      label: "Self-test",
      level: "fail",
      detail: `FAILED ${when} — ${failed || "no check detail"}`,
    };
  }
  if (nowMs - s.ranAtMs > SELFTEST_STALE_MS) {
    return {
      id: "selftest",
      label: "Self-test",
      level: "warn",
      detail: `passed, but ${when} — older than the installed build is likely to be`,
    };
  }
  return { id: "selftest", label: "Self-test", level: "ok", detail: `passed ${when}` };
}

function lastSync(r: DoctorReport, nowMs: number): Invariant {
  const s = r.sync;
  const pending = `${count(s.pendingRows)} pending`;
  const anchor = s.lastCloudWriteMs ?? s.lastFlushOkMs;
  if (anchor === null) {
    return {
      id: "sync",
      label: "Last cloud write",
      level: "warn",
      detail: `never — ${pending}${s.lastFlushError === null ? "" : ` (last error: ${s.lastFlushError})`}`,
    };
  }
  const silentMs = s.silentForMs ?? nowMs - anchor;
  const when = `${stamp(anchor)} (${ago(silentMs)}), ${pending}`;
  if (silentMs > SYNC_SILENT_FAIL_MS) {
    return {
      id: "sync",
      label: "Last cloud write",
      level: "fail",
      detail: `${when} — silent for more than 72 h`,
    };
  }
  if (s.lastFlushError !== null) {
    return { id: "sync", label: "Last cloud write", level: "warn", detail: `${when} — last error: ${s.lastFlushError}` };
  }
  return { id: "sync", label: "Last cloud write", level: "ok", detail: when };
}

function fingerprint(r: DoctorReport): Invariant {
  const f = r.fingerprint;
  if (f.matched === null || f.checkedAtMs === null) {
    return {
      id: "fingerprint",
      label: "Fingerprint",
      level: "warn",
      detail: "never checked — this is the layer that catches SILENT loss",
    };
  }
  const when = stamp(f.checkedAtMs);
  const counts = `local ${count(f.localCount ?? 0)} vs cloud ${count(f.cloudCount ?? 0)}`;
  if (!f.matched) {
    return {
      id: "fingerprint",
      label: "Fingerprint",
      level: "fail",
      detail: `MISMATCH at ${when} — ${counts}`,
    };
  }
  return { id: "fingerprint", label: "Fingerprint", level: "ok", detail: `matched at ${when} — ${counts}` };
}

function backup(r: DoctorReport, nowMs: number): Invariant {
  const b = r.backup;
  if (b.lastAtMs === null && b.ageDays === null) {
    return { id: "backup", label: "Newest backup", level: "warn", detail: "none taken yet" };
  }
  const ageMs = b.lastAtMs === null ? (b.ageDays ?? 0) * DAY : nowMs - b.lastAtMs;
  const where = b.destination === null ? "" : ` → ${b.destination}`;
  const when = `${b.lastAtMs === null ? "?" : stamp(b.lastAtMs)} (${ago(ageMs)}), ${count(b.kept)} kept${where}`;
  if (ageMs > BACKUP_FAIL_MS) {
    return { id: "backup", label: "Newest backup", level: "fail", detail: `${when} — weekly export has stopped` };
  }
  if (ageMs > BACKUP_WARN_MS) {
    return { id: "backup", label: "Newest backup", level: "warn", detail: `${when} — a week has been missed` };
  }
  return { id: "backup", label: "Newest backup", level: "ok", detail: when };
}

function localRows(r: DoctorReport): Invariant {
  const d = r.db;
  const open = d.openIntervalPresent ? ", one interval open" : "";
  const body = `${count(d.rows)} intervals, ${mb(d.sizeBytes)}${open}`;
  if (!d.integrityOk) {
    return { id: "rows", label: "Local rows", level: "fail", detail: `${body} — INTEGRITY CHECK FAILED (${d.path})` };
  }
  if (d.rows === 0) {
    return { id: "rows", label: "Local rows", level: "warn", detail: `${body} — nothing recorded yet` };
  }
  return { id: "rows", label: "Local rows", level: "ok", detail: body };
}

/** Pure. The whole point of this file: a report in, a verdict out. */
export function evaluate(report: DoctorReport, nowMs: number): Invariant[] {
  return [
    inputMonitoring(report),
    accessibility(report),
    tapAlive(report, nowMs),
    grantedMask(report),
    selfTest(report, nowMs),
    lastSync(report, nowMs),
    fingerprint(report),
    backup(report, nowMs),
    localRows(report),
  ];
}

/** Non-zero if any invariant is red. Warnings never fail the run. */
export function exitCodeFor(invariants: readonly Invariant[]): number {
  return invariants.some((i) => i.level === "fail") ? 1 : 0;
}

// ── rendering ───────────────────────────────────────────────────────────────

const MARK: Record<Level, string> = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]" };
const COLOR: Record<Level, string> = { ok: "\u001b[32m", warn: "\u001b[33m", fail: "\u001b[31m" };
const RESET = "\u001b[0m";

export interface RenderOptions {
  color: boolean;
  nowMs: number;
}

export function renderLine(inv: Invariant, color: boolean): string {
  const mark = color ? `${COLOR[inv.level]}${MARK[inv.level]}${RESET}` : MARK[inv.level];
  return `${mark} ${inv.label.padEnd(18)} ${inv.detail}`;
}

export function render(report: DoctorReport, invariants: readonly Invariant[], o: RenderOptions): string {
  const bold = (s: string): string => (o.color ? `\u001b[1m${s}${RESET}` : s);
  const lines: string[] = [];
  lines.push(bold("Work Week Buddy — doctor"));
  lines.push(
    `report ${stamp(report.generatedAtMs)} (${ago(o.nowMs - report.generatedAtMs)}) · v${report.app.version} · ${report.machine.label || report.machine.machineId}`,
  );
  // Not scored, but the first thing to check when every permission looks wrong:
  // grants belong to the bundle at APP_PATH, so a dev build has none of them.
  const installed = report.app.execPath.startsWith(APP_PATH);
  lines.push(
    `running ${report.app.execPath}${installed ? "" : `  ← NOT the installed bundle; its grants are a different app's`}`,
  );
  lines.push("");
  for (const inv of invariants) lines.push(renderLine(inv, o.color));
  lines.push("");

  const failed = invariants.filter((i) => i.level === "fail").length;
  const warned = invariants.filter((i) => i.level === "warn").length;
  const passed = invariants.length - failed - warned;
  lines.push(`${passed} ok · ${warned} warning(s) · ${failed} failed`);
  if (failed === 0 && !report.allGreen) {
    // Our thresholds and the app's own summary disagree. Say so rather than
    // quietly picking a winner.
    lines.push("note: every invariant above holds, but the app reports allGreen=false.");
  }
  return `${lines.join("\n")}\n`;
}

// ── collection (the only part that touches the machine) ─────────────────────

/**
 * Electron writes its own noise to stdout. Take the outermost JSON object
 * rather than assuming the report is the only thing on the stream.
 */
export function extractJson(stdout: string): DoctorReport {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in --doctor output");
  return JSON.parse(stdout.slice(start, end + 1)) as DoctorReport;
}

export async function collectReport(bin: string): Promise<DoctorReport> {
  const { stdout } = await run(bin, ["--doctor"], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  return extractJson(stdout);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export interface CliOptions {
  reportPath: string | null;
  bin: string;
  json: boolean;
  color: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[], isTty: boolean): CliOptions {
  const o: CliOptions = { reportPath: null, bin: APP_BIN, json: false, color: isTty, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") o.reportPath = argv[++i] ?? "-";
    else if (a === "--app") o.bin = `${argv[++i] ?? APP_PATH}/Contents/MacOS/Work Week Buddy`;
    else if (a === "--json") o.json = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--color") o.color = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

export const USAGE = `usage: npm run doctor -- [--report FILE|-] [--app /path/to/App.app] [--json] [--no-color]

  --report FILE   read a DoctorReport JSON instead of running the app ('-' = stdin)
  --app PATH      run a different bundle (default ${APP_PATH})
  --json          print the raw report and nothing else
  --no-color      plain output

exit: 0 all invariants hold (warnings allowed) · 1 at least one is red · 2 no report
`;

export async function main(argv: readonly string[]): Promise<number> {
  let o: CliOptions;
  try {
    o = parseArgs(argv, process.stdout.isTTY === true);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let report: DoctorReport;
  try {
    if (o.reportPath === "-") report = extractJson(await readStdin());
    else if (o.reportPath !== null) report = extractJson(await readFile(o.reportPath, "utf8"));
    else report = await collectReport(o.bin);
  } catch (err) {
    process.stderr.write(`doctor: could not obtain a report — ${(err as Error).message}\n`);
    if (o.reportPath === null) {
      process.stderr.write(`doctor: is the app installed at ${APP_PATH}? Run ./scripts/install.sh\n`);
    }
    return 2;
  }

  const nowMs = Date.now();
  const invariants = evaluate(report, nowMs);

  // --json changes the OUTPUT, never the verdict: the exit code has to mean the
  // same thing in both modes, or a script that adds --json for logging silently
  // changes what it is gating on.
  if (o.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(invariants);
  }

  process.stdout.write(render(report, invariants, { color: o.color, nowMs }));
  return exitCodeFor(invariants);
}

// Only when executed directly. Importing this file from a test must not run it.
if (process.argv[1] !== undefined && process.argv[1].endsWith("doctor.ts")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`doctor: ${String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
