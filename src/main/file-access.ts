/**
 * THE FREEZE — the bug that shipped a menu-bar app with no windows.
 *
 * macOS asks for consent the FIRST time a process touches iCloud Drive or
 * `~/Documents`, and it asks by BLOCKING the syscall that triggered it until
 * the dialog is answered. Every filesystem call in the backup layer is
 * synchronous — `readdirSync` in `latestBackup()`, `mkdirSync`/`renameSync` in
 * `weeklyBackup()`, and sqlite's own `VACUUM INTO`, which writes straight into
 * the backup directory. On a LaunchServices launch that block lands on the
 * ELECTRON MAIN THREAD, and a blocked main thread is not a slow app: it is a
 * dead event loop.
 *
 * What the owner saw, all one symptom:
 *
 *   - tray icon present, database open — both happen BEFORE the freeze
 *   - zero windows, ever: `showOnboarding()`/`showDashboard()` never ran
 *   - a second launch did nothing: `second-instance` never fired
 *   - completely empty stderr: nothing after the freeze can log, because
 *     nothing after the freeze RUNS
 *
 * And why every test was green: a process started from a terminal inherits the
 * TERMINAL's TCC responsibility, so the prompt never appears and the call
 * returns in microseconds. `npm run smoke` runs `electron .` from a shell.
 * There was no way for it to see this.
 *
 * THE FIX. Take the wait on the libuv THREADPOOL, where blocking is legal,
 * before running any of the synchronous work. `fs.promises.readdir` triggers
 * exactly the same consent check, and once macOS has an answer cached for this
 * process the synchronous calls cannot block again. The app stays alive with
 * the dialog on screen, which is the whole point.
 *
 * Deny is a perfectly good answer. The synchronous calls then fail fast with
 * EPERM and the backup layer already models "the directory is not writable".
 * The one outcome that must never repeat is waiting forever with the main
 * thread held.
 */
import { readdir } from "node:fs/promises";

/**
 * What macOS decided, or that it has not decided yet.
 *
 * `undecided` is a real state, not an error: the dialog is on screen and
 * nobody has answered it. The caller skips the work and says so out loud.
 */
export type DirectoryAccess = "allowed" | "denied" | "undecided";

/**
 * Long enough for a human to find a dialog an `LSUIElement` app cannot bring
 * to the front, short enough that a launch is never held hostage by one.
 */
export const ACCESS_TIMEOUT_MS = 20_000;

export interface DirectoryAccessOptions {
  /** The async probe. Injected so the decision is testable without a TCC prompt. */
  readonly probe?: (dir: string) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (t: NodeJS.Timeout) => void;
}

/** ENOENT is not a refusal — the directory simply is not there yet. */
function decide(err: unknown): DirectoryAccess {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "allowed" : "denied";
}

/**
 * Resolves once macOS has an answer for this process, or `undecided` when the
 * dialog is still sitting there unanswered.
 *
 * NEVER rejects, and never blocks the caller's thread. The returned promise is
 * the only thing that waits.
 */
export async function awaitDirectoryAccess(
  dir: string,
  opts: DirectoryAccessOptions = {},
): Promise<DirectoryAccess> {
  const probe = opts.probe ?? readdir;
  const timeoutMs = opts.timeoutMs ?? ACCESS_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;

  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<DirectoryAccess>((resolve) => {
    timer = setTimer(() => resolve("undecided"), timeoutMs);
    // A launch must not be kept alive by a dialog nobody is going to answer.
    timer.unref?.();
  });
  const answered = probe(dir).then(
    (): DirectoryAccess => "allowed",
    (err: unknown): DirectoryAccess => decide(err),
  );

  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}

/**
 * One decision per process, asked once.
 *
 * The promise is memoised rather than the answer: a probe that timed out is
 * still pending, so a later cycle — the one after the owner finally clicks
 * Allow — gets the real answer instead of re-prompting.
 */
export function createDirectoryAccessGate(
  dir: string,
  opts: DirectoryAccessOptions = {},
): () => Promise<DirectoryAccess> {
  const probe = opts.probe ?? readdir;
  // Started once, on the first ask. The prompt is one per process, and asking
  // twice would put a second dialog behind the first.
  let asked: Promise<unknown> | null = null;
  let settled: DirectoryAccess | null = null;
  return async () => {
    if (settled !== null) return settled;
    asked ??= probe(dir);
    const answer = await awaitDirectoryAccess(dir, { ...opts, probe: () => asked as Promise<unknown> });
    if (answer !== "undecided") settled = answer;
    return answer;
  };
}
