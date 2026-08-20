/**
 * The open-interval journal — one row, rewritten as the interval moves.
 *
 * This is what makes a `kill -9` cost under 30 seconds instead of a whole
 * session. The 30 seconds comes from the write cadence, not from any
 * approximation of where the interval ended.
 *
 * `last_signal_ms` is the last REAL signal, never the last write time. That
 * column is what crash recovery closes at, so writing `Date.now()` into it
 * turns every crash into up to 15 donated phantom minutes — the close-rule bug,
 * one layer down.
 */
import type { DatabaseSync } from "node:sqlite";
import { NO_SIGNAL, type OpenInterval } from "../core/types";
import { n, s, type Row } from "./coerce";

/**
 * 1:1 with the `open_interval` columns.
 *
 * `docs/IMPL_STORE_SYNC.md` §3 types these as `OpenInterval`, but that type
 * carries no `machineId` and carries three fields the table has no column for
 * (`micMs` and the three `…SinceMs` span cursors), so it cannot round-trip.
 * `snapshotFromOpen` and `openFromSnapshot` are the two bridges.
 */
export interface JournalSnapshot {
  readonly id: string;
  readonly machineId: string;
  readonly startedAtMs: number;
  /** THE load-bearing field. The interval will end here, and nowhere else. */
  readonly lastSignalMs: number;
  readonly keyEvents: number;
  readonly mouseEvents: number;
  readonly cameraS: number;
  readonly jigglerS: number;
}

/**
 * Seal the currently-open camera and jiggler spans at the last real signal, so
 * the snapshot answers "what this interval would be if it closed right now".
 * The spans are sealed at `lastRealSignalMs`, never at the write instant — the
 * close rule applies to the parts as well as to the whole.
 */
export function snapshotFromOpen(open: OpenInterval, machineId: string): JournalSnapshot {
  const span = (sinceMs: number): number =>
    sinceMs === NO_SIGNAL ? 0 : Math.max(0, open.lastRealSignalMs - sinceMs);
  return {
    id: open.id,
    machineId,
    startedAtMs: open.startedAtMs,
    lastSignalMs: open.lastRealSignalMs,
    keyEvents: open.keyEvents,
    mouseEvents: open.mouseEvents,
    cameraS: Math.round((open.cameraMs + span(open.cameraSinceMs)) / 1000),
    jigglerS: Math.round((open.jigglerMs + span(open.jigglerSinceMs)) / 1000),
  };
}

/**
 * Rebuild an `OpenInterval` for `reduce({ kind: "boot", journalled })`.
 *
 * Two fields the table cannot hold are reconstructed conservatively:
 * `micMs` is 0 (never journalled), and `lastInputMs` is only claimed when the
 * journal proves input happened — otherwise it stays `NO_SIGNAL`, so a
 * camera-only session cannot come back from a crash with its cap silently
 * reset by evidence that was never recorded.
 */
export function openFromSnapshot(snap: JournalSnapshot): OpenInterval {
  const hadInput = snap.keyEvents + snap.mouseEvents > 0;
  return {
    id: snap.id,
    startedAtMs: snap.startedAtMs,
    startSource: "recovery",
    lastRealSignalMs: snap.lastSignalMs,
    lastInputMs: hadInput ? snap.lastSignalMs : NO_SIGNAL,
    keyEvents: snap.keyEvents,
    mouseEvents: snap.mouseEvents,
    cameraMs: snap.cameraS * 1000,
    micMs: 0,
    jigglerMs: snap.jigglerS * 1000,
    cameraSinceMs: NO_SIGNAL,
    micSinceMs: NO_SIGNAL,
    jigglerSinceMs: NO_SIGNAL,
  };
}

/**
 * Exported so the crash test can run the *same* statement inside a process it
 * then SIGKILLs. A second copy of this SQL in a test fixture would drift.
 */
export const JOURNAL_UPSERT_SQL = `INSERT INTO open_interval
       (singleton,id,machine_id,started_at_ms,last_signal_ms,key_events,mouse_events,camera_s,jiggler_s)
     VALUES (1,?,?,?,?,?,?,?,?)
     ON CONFLICT(singleton) DO UPDATE SET
       id=excluded.id, machine_id=excluded.machine_id, started_at_ms=excluded.started_at_ms,
       last_signal_ms=excluded.last_signal_ms, key_events=excluded.key_events,
       mouse_events=excluded.mouse_events, camera_s=excluded.camera_s, jiggler_s=excluded.jiggler_s`;

/** Upsert the single open-interval row. `null` clears it. */
export function writeJournal(db: DatabaseSync, snap: JournalSnapshot | null): void {
  if (snap === null) {
    db.prepare("DELETE FROM open_interval WHERE singleton = 1").run();
    return;
  }
  db.prepare(JOURNAL_UPSERT_SQL).run(
    snap.id,
    snap.machineId,
    snap.startedAtMs,
    snap.lastSignalMs,
    snap.keyEvents,
    snap.mouseEvents,
    snap.cameraS,
    snap.jigglerS,
  );
}

/** Read it at boot. */
export function readJournal(db: DatabaseSync): JournalSnapshot | null {
  const raw = db.prepare("SELECT * FROM open_interval WHERE singleton = 1").get();
  if (raw === undefined) return null;
  const row = raw as Row;
  return {
    id: s(row, "id"),
    machineId: s(row, "machine_id"),
    startedAtMs: n(row, "started_at_ms"),
    lastSignalMs: n(row, "last_signal_ms"),
    keyEvents: n(row, "key_events"),
    mouseEvents: n(row, "mouse_events"),
    cameraS: n(row, "camera_s"),
    jigglerS: n(row, "jiggler_s"),
  };
}
