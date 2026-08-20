/**
 * Closed intervals — the only rows this product has.
 *
 * Append-only, always. A closed interval is immutable: the only UPDATE any code
 * path here issues touches `cloud_seq` and `synced_at_ms`, which are sync
 * bookkeeping and not payload. There is no DELETE, and there is a test that
 * greps this directory to keep it that way. Exclusion is a query-time filter in
 * `v_countable`, never a row that goes away.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ClosedInterval } from "../core/types";
import { localDateOf } from "./dates";
import { n, nOrNull, s, type Row } from "./coerce";

/**
 * The payload half of a row: exactly the columns the Worker stores, so the
 * mirror and the cloud hold byte-identical interval sets.
 */
export interface CloudPayload {
  readonly id: string;
  readonly machineId: string;
  readonly startedAtMs: number;
  /** The LAST REAL SIGNAL. Never the timeout instant, never `now()`. */
  readonly endedAtMs: number;
  readonly durationS: number;
  readonly endReason: string;
  readonly tz: string;
  readonly localDate: string;
  readonly keyEvents: number;
  readonly mouseEvents: number;
  readonly cameraS: number;
  readonly jigglerS: number;
  readonly appVersion: string;
  readonly schemaV: number;
  readonly closedLocalMs: number;
  /** Stamped by the Worker at insert. NULL until this row has been uploaded. */
  readonly serverMs: number | null;
  /** Server-assigned. NULL until the cloud has it. The only pull watermark. */
  readonly cloudSeq: number | null;
}

export interface IntervalRow extends CloudPayload {
  /** Equal to `endedAtMs`, by CHECK constraint. See `schema.ts`. */
  readonly lastSignalAtMs: number;
  /** NULL = pending upload. The mirror IS the outbox; there is no queue table. */
  readonly syncedAtMs: number | null;
}

export interface RowMeta {
  readonly machineId: string;
  /** IANA zone at close. `localDate` is minted from it. */
  readonly tz: string;
  readonly appVersion: string;
  /** Client wall clock at close, for skew diagnosis. */
  readonly closedLocalMs: number;
  readonly schemaV?: number;
}

/**
 * `ClosedInterval` (`src/core/`) → a storable row.
 *
 * `docs/IMPL_STORE_SYNC.md` §2 declares `IntervalRow extends ClosedInterval`,
 * but the schema in `docs/DATA_MODEL.md` has no column for `startSource`,
 * `lastInputMs` or `micMs`, so that type cannot round-trip through the
 * database. The row type here is 1:1 with the columns instead — which also
 * keeps the mirror's payload identical to the cloud's, the thing the weekly
 * fingerprint check depends on — and this function is the bridge.
 */
export function rowFromClosed(interval: ClosedInterval, meta: RowMeta): IntervalRow {
  return {
    id: interval.id,
    machineId: meta.machineId,
    startedAtMs: interval.startedAtMs,
    endedAtMs: interval.endedAtMs,
    lastSignalAtMs: interval.lastRealSignalMs,
    durationS: interval.durationS,
    endReason: interval.endReason,
    tz: meta.tz,
    localDate: localDateOf(interval.startedAtMs, meta.tz),
    keyEvents: interval.keyEvents,
    mouseEvents: interval.mouseEvents,
    cameraS: Math.round(interval.cameraMs / 1000),
    jigglerS: Math.round(interval.jigglerMs / 1000),
    appVersion: meta.appVersion,
    schemaV: meta.schemaV ?? 1,
    closedLocalMs: meta.closedLocalMs,
    serverMs: null,
    cloudSeq: null,
    syncedAtMs: null,
  };
}

const INSERT_SQL = `INSERT INTO work_interval (
  id, machine_id, started_at_ms, ended_at_ms, last_signal_at_ms, duration_s,
  end_reason, tz, local_date, key_events, mouse_events, camera_s, jiggler_s,
  app_version, schema_v, closed_local_ms, server_ms, cloud_seq, synced_at_ms
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO NOTHING`;

function bindRow(row: IntervalRow): Array<string | number | null> {
  return [
    row.id,
    row.machineId,
    row.startedAtMs,
    row.endedAtMs,
    row.lastSignalAtMs,
    row.durationS,
    row.endReason,
    row.tz,
    row.localDate,
    row.keyEvents,
    row.mouseEvents,
    row.cameraS,
    row.jigglerS,
    row.appVersion,
    row.schemaV,
    row.closedLocalMs,
    row.serverMs,
    row.cloudSeq,
    row.syncedAtMs,
  ];
}

/**
 * The ONLY way a row is created. The id is client-minted at close, so a retry
 * — this week or in three weeks — is the same insert and does nothing twice.
 *
 * Nothing here validates `endedAtMs === lastSignalAtMs`. The CHECK constraint
 * does, in the file format, where a future refactor cannot talk its way past
 * it. Returns true if the row was new.
 */
export function insertClosed(db: DatabaseSync, row: IntervalRow): boolean {
  const res = db.prepare(INSERT_SQL).run(...bindRow(row));
  return Number(res.changes) > 0;
}

/** Rows awaiting upload, oldest first. The mirror IS the outbox. */
export function pendingRows(db: DatabaseSync, limit = 200): IntervalRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM work_interval WHERE synced_at_ms IS NULL
       ORDER BY ended_at_ms ASC, id ASC LIMIT ?`,
    )
    .all(limit);
  return rows.map(toRow);
}

export function getRow(db: DatabaseSync, id: string): IntervalRow | null {
  const row = db.prepare(`SELECT * FROM work_interval WHERE id = ?`).get(id);
  return row === undefined ? null : toRow(row);
}

export function countIntervals(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM work_interval`).get();
  return n(row as Row, "c");
}

/**
 * How many rows are still in the outbox.
 *
 * `pendingRows(db).length` is NOT this number — it pages at 200, so a machine
 * three weeks offline would report "200 pending" forever and the doctor would
 * be quietly wrong about the one figure it exists to be right about. Served by
 * the `ix_pending` partial index.
 */
export function pendingCount(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NULL`)
    .get();
  return n(row as Row, "c");
}

/**
 * Called ONLY after an HTTP 200, and keyed on the ids the server reports
 * PRESENT — never on what the INSERT claimed to affect. A response lost after
 * the server committed replays into the same presence answer next time.
 *
 * `synced_at_ms` is set once and then left alone: the first time the cloud
 * confirmed the row is the honest answer, and a later replay must not move it.
 */
export function markSynced(
  db: DatabaseSync,
  present: ReadonlyArray<{ id: string; seq: number }>,
  atMs: number,
): void {
  if (present.length === 0) return;
  const stmt = db.prepare(
    `UPDATE work_interval
        SET cloud_seq = ?, synced_at_ms = COALESCE(synced_at_ms, ?)
      WHERE id = ?`,
  );
  db.exec("BEGIN");
  try {
    for (const p of present) stmt.run(p.seq, atMs, p.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Ingest rows pulled from the cloud. Arriving twice, out of order, or three
 * weeks late are all the same thing.
 *
 * The cloud has no `last_signal_at_ms` column — it does not need one, because
 * `ended_at_ms` *is* the last signal. Re-deriving it here is what lets the same
 * CHECK constraint hold over rows that were written on the other Mac.
 */
export function ingest(
  db: DatabaseSync,
  rows: readonly CloudPayload[],
  atMs = Date.now(),
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const res = stmt.run(
        ...bindRow({
          ...r,
          lastSignalAtMs: r.endedAtMs,
          // A pulled row is in the cloud by definition, so it is not outbox
          // work. Marking it here is what keeps the other machine's history
          // out of our upload queue forever.
          syncedAtMs: atMs,
        }),
      );
      inserted += Number(res.changes);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return inserted;
}

function toRow(raw: Record<string, unknown>): IntervalRow {
  const row = raw as Row;
  return {
    id: s(row, "id"),
    machineId: s(row, "machine_id"),
    startedAtMs: n(row, "started_at_ms"),
    endedAtMs: n(row, "ended_at_ms"),
    lastSignalAtMs: n(row, "last_signal_at_ms"),
    durationS: n(row, "duration_s"),
    endReason: s(row, "end_reason"),
    tz: s(row, "tz"),
    localDate: s(row, "local_date"),
    keyEvents: n(row, "key_events"),
    mouseEvents: n(row, "mouse_events"),
    cameraS: n(row, "camera_s"),
    jigglerS: n(row, "jiggler_s"),
    appVersion: s(row, "app_version"),
    schemaV: n(row, "schema_v"),
    closedLocalMs: n(row, "closed_local_ms"),
    serverMs: nOrNull(row, "server_ms"),
    cloudSeq: nOrNull(row, "cloud_seq"),
    syncedAtMs: nOrNull(row, "synced_at_ms"),
  };
}
