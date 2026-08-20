/**
 * `sync_state` — two keys, both owned by `src/sync/`.
 *
 * `pull_watermark`      the highest cloud `seq` ingested. Pull starts 200 rows
 *                       behind it, because AUTOINCREMENT identity values can
 *                       become visible out of order.
 * `last_cloud_write_ms` the silence alarm's input: older than 72 h and the tray
 *                       icon changes.
 */
import type { DatabaseSync } from "node:sqlite";
import { n, s, sOrNull, type Row } from "./coerce";

export type SyncKey = "pull_watermark" | "last_cloud_write_ms";

export function getSyncState(db: DatabaseSync, k: SyncKey): string | null {
  const raw = db.prepare("SELECT v FROM sync_state WHERE k = ?").get(k);
  return raw === undefined ? null : s(raw as Row, "v");
}

export function setSyncState(db: DatabaseSync, k: SyncKey, v: string): void {
  db.prepare(
    `INSERT INTO sync_state (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(k, v);
}

/** One row of the `machine` table: liveness, plus the human-facing label. */
export interface MachineRecord {
  readonly machineId: string;
  readonly label: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly lastSeenMs: number;
}

/**
 * Liveness rows for the per-machine breakdown's labels.
 *
 * ── ONE CONFLICT RULE, AND IT IS `last_seen_ms` ─────────────────────────────
 * Four writers reach this table: this Mac at boot, this Mac on rename, the
 * heartbeat this Mac just sent, and machine rows pulled out of the cloud that
 * the OTHER Mac wrote. They arrive in any order, stamped by two clocks, and a
 * pull can carry a label that was already stale when the range read ran.
 *
 * `last_seen_ms` decides all of it — the same rule the Worker's own heartbeat
 * upsert uses, rather than a second rule invented for this side. A write that
 * is not newer than what is stored may not touch the descriptive fields, so a
 * pull of yesterday's cloud row cannot revert a rename made ten seconds ago
 * while offline. A write that IS newer still may not ERASE: binding NULL keeps
 * the stored value, because a heartbeat that omitted a field is saying nothing
 * about it rather than clearing it.
 */
export function upsertMachine(
  db: DatabaseSync,
  m: {
    machineId: string;
    label?: string;
    osVersion?: string;
    appVersion?: string;
    lastSeenMs: number;
  },
): void {
  db.prepare(
    `INSERT INTO machine (machine_id,label,os_version,app_version,last_seen_ms)
     VALUES (?,?,?,?,?)
     ON CONFLICT(machine_id) DO UPDATE SET
       label=CASE WHEN excluded.last_seen_ms >= machine.last_seen_ms
                  THEN COALESCE(excluded.label, machine.label)
                  ELSE machine.label END,
       os_version=CASE WHEN excluded.last_seen_ms >= machine.last_seen_ms
                       THEN COALESCE(excluded.os_version, machine.os_version)
                       ELSE machine.os_version END,
       app_version=CASE WHEN excluded.last_seen_ms >= machine.last_seen_ms
                        THEN COALESCE(excluded.app_version, machine.app_version)
                        ELSE machine.app_version END,
       -- commutative: an out-of-order heartbeat can never move it backwards
       last_seen_ms=MAX(machine.last_seen_ms, excluded.last_seen_ms)`,
  ).run(
    m.machineId,
    m.label ?? null,
    m.osVersion ?? null,
    m.appVersion ?? null,
    m.lastSeenMs,
  );
}

/** Every machine this mirror knows about, ours included. */
export function readMachines(db: DatabaseSync): MachineRecord[] {
  const rows = db
    .prepare(
      `SELECT machine_id, label, os_version, app_version, last_seen_ms
         FROM machine ORDER BY machine_id`,
    )
    .all();
  return rows.map((raw) => {
    const row = raw as Row;
    return {
      machineId: s(row, "machine_id"),
      label: sOrNull(row, "label"),
      osVersion: sOrNull(row, "os_version"),
      appVersion: sOrNull(row, "app_version"),
      lastSeenMs: n(row, "last_seen_ms"),
    };
  });
}
