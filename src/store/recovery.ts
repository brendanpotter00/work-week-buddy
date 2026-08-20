/**
 * Crash recovery — task 3.2.
 *
 * Sleep, lid-close, App Nap, force-quit, power loss and reboot all arrive here
 * as the same thing: a journal row that outlived the process that wrote it.
 *
 * A stale journal closes at `last_signal_ms`. Never at `nowMs`, never at the
 * app's launch time, never at the timeout instant. `end_reason` is
 * `crash_recovered` so the row is countable in the soak gate: more than two in
 * two weeks is a real bug, not noise.
 *
 * This runs BEFORE the tap starts, so no live signal can race the journal.
 *
 * `docs/IMPL_TASKS_EXPANDED.md` §T3.2 files this under `src/main/recovery.ts`.
 * It lives in `src/store/` because everything it touches is the store, because
 * `src/main/` is the boot task's directory, and because keeping it here means
 * the whole of it is testable in a plain Node process with no electron.
 */
import type { DatabaseSync } from "node:sqlite";
import { localDateOf } from "./dates";
import { insertClosed, type IntervalRow } from "./intervals";
import { readJournal, writeJournal, type JournalSnapshot } from "./journal";

/** One idle timeout. A relaunch inside it is one continuous session. */
export const CRASH_FRESH_MS = 15 * 60_000;

export type RecoveryOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "resumed"; readonly snapshot: JournalSnapshot }
  | {
      readonly kind: "closed";
      readonly row: IntervalRow;
      /**
       * How stale the journal was: `nowMs - endedAtMs`. A diagnostic, not a
       * measure of lost tracking — the data actually lost is bounded by the
       * journal's write cadence, which is under a second.
       */
      readonly journalAgeMs: number;
    };

export interface RecoveryConfig {
  readonly tz: string;
  readonly appVersion: string;
  /** Defaults to `CRASH_FRESH_MS`. */
  readonly freshMs?: number;
}

/**
 * Freshness is measured against the LAST SIGNAL, not against the app's start
 * time. An app that took 40 seconds to relaunch has not made the session any
 * older than the last thing the human actually did.
 */
export function isFresh(snap: JournalSnapshot, nowMs: number, freshMs = CRASH_FRESH_MS): boolean {
  return nowMs - snap.lastSignalMs < freshMs;
}

export function recover(db: DatabaseSync, nowMs: number, cfg: RecoveryConfig): RecoveryOutcome {
  const snap = readJournal(db);
  if (snap === null) return { kind: "none" };
  if (isFresh(snap, nowMs, cfg.freshMs ?? CRASH_FRESH_MS)) {
    return { kind: "resumed", snapshot: snap };
  }

  // A journal whose last signal predates its own start is corrupt, not
  // evidence. Collapse it to a zero-length interval rather than crashing the
  // app at boot: `v_countable` drops it on the stray-bump floor, and no number
  // in the product moves.
  const endedAtMs = Math.max(snap.startedAtMs, snap.lastSignalMs);

  const row: IntervalRow = {
    id: snap.id, // the journal's id, so a row the crashed process already
    // flushed re-inserts as an ON CONFLICT DO NOTHING no-op
    machineId: snap.machineId,
    startedAtMs: snap.startedAtMs,
    endedAtMs,
    lastSignalAtMs: endedAtMs,
    durationS: Math.round((endedAtMs - snap.startedAtMs) / 1000),
    endReason: "crash_recovered",
    tz: cfg.tz,
    localDate: localDateOf(snap.startedAtMs, cfg.tz),
    keyEvents: snap.keyEvents,
    mouseEvents: snap.mouseEvents,
    cameraS: snap.cameraS,
    jigglerS: snap.jigglerS,
    appVersion: cfg.appVersion,
    schemaV: 1,
    // The wall clock at close IS now — this column is the skew diagnostic, and
    // it is the one place `nowMs` legitimately belongs. It is not the end of
    // the interval and is never read as one.
    closedLocalMs: nowMs,
    serverMs: null,
    cloudSeq: null,
    syncedAtMs: null,
  };

  insertClosed(db, row);
  writeJournal(db, null);
  return { kind: "closed", row, journalAgeMs: nowMs - endedAtMs };
}
