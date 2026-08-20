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
import { s, type Row } from "./coerce";

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

/** Liveness rows for the per-machine breakdown's labels. */
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
       -- A heartbeat that omits a field must not erase it. Binding NULL and
       -- keeping the stored value means a late or partial heartbeat cannot
       -- revert a machine labelled "work" back to its raw id.
       label=COALESCE(excluded.label, machine.label),
       os_version=COALESCE(excluded.os_version, machine.os_version),
       app_version=COALESCE(excluded.app_version, machine.app_version),
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
