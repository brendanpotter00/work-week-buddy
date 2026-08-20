/**
 * One logger, so a diagnostic line is greppable and a stack trace is not lost
 * inside a `void promise.catch(() => {})`.
 *
 * ── AND A FILE, BECAUSE A GUI LAUNCH HAS NO STDERR ──────────────────────────
 * `console.*` reaches a terminal and nowhere else. The app the owner runs is
 * launched by Finder or by a LaunchAgent, and everything either of those
 * launches writes to stdout goes to `/dev/null`. When the packaged app froze
 * on boot the report was "stderr is completely empty" — and it was, because
 * there was nowhere for it to be non-empty.
 *
 * So every line also goes to `<userData>/wwb.log`. `userData` is the app's own
 * directory: local, never a network volume, and not TCC-protected, which
 * matters because the last thing this file may do is block the main thread
 * (`src/main/file-access.ts`).
 *
 * `appendFileSync` on purpose. The lines that matter most are the ones written
 * immediately before something stops running, and an async write is a write
 * that never happens when the thing that stops running is the event loop.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** Rotated at a megabyte, one generation kept. A log nobody can open is not one. */
const MAX_BYTES = 1_000_000;

export const LOG_FILENAME = "wwb.log";

let sink: string | null = null;
/** One complaint, not one per line: a broken sink must not become the noise. */
let sinkBroken = false;

/**
 * Point the file sink at a directory — `app.getPath("userData")`.
 *
 * Called once, early in `index.ts`. Before it is called the logger is
 * console-only, which is the right behaviour for the unit tests and for any
 * caller that has no Electron.
 */
export function logToDirectory(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    sink = join(dir, LOG_FILENAME);
    sinkBroken = false;
    rotateIfHuge(sink);
    return sink;
  } catch {
    sink = null;
    return null;
  }
}

/** Test seam, and the honest answer to "where is the log". */
export function logFilePath(): string | null {
  return sink;
}

function rotateIfHuge(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // No file yet, or an unwritable directory. Both are handled by the append.
  }
}

function toFile(line: string): void {
  if (sink === null || sinkBroken) return;
  try {
    appendFileSync(sink, line);
  } catch {
    sinkBroken = true;
    console.error(`[wwb] log file is not writable: ${sink ?? "?"} — console only from here`);
  }
}

function detailOf(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  try {
    return ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

function emit(level: "info" | "warn" | "error", msg: string, detail?: unknown): void {
  const text = `${msg}${detailOf(detail)}`;
  const console_ = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  if (detail === undefined) console_(`[wwb] ${msg}`);
  else console_(`[wwb] ${msg}`, detail);
  toFile(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`);
}

export const log = {
  info(msg: string, detail?: unknown): void {
    emit("info", msg, detail);
  },
  warn(msg: string, detail?: unknown): void {
    emit("warn", msg, detail);
  },
  error(msg: string, detail?: unknown): void {
    emit("error", msg, detail);
  },
  /**
   * A named step of the boot sequence.
   *
   * These exist because of how the freeze was found: the log simply STOPPED,
   * and the last line named the call that never returned. A boot that dies or
   * hangs anywhere now leaves that same evidence in `wwb.log` without anybody
   * having to reproduce it under a debugger.
   */
  boot(step: string): void {
    emit("info", `boot: ${step}`);
  },
};

/** Only for tests, which must not inherit a sink from another file. */
export function resetLogSinkForTests(): void {
  sink = null;
  sinkBroken = false;
}

/** Where the log would go for a given userData directory, without opening it. */
export function logPathFor(userDataDir: string): string {
  return join(userDataDir, LOG_FILENAME);
}
