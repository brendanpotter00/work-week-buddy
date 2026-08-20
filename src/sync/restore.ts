/**
 * Reading a weekly NDJSON export back in.
 *
 * The export is only a backup if it restores, and a backup nobody has ever
 * restored is a hypothesis. This is the other half of `weeklyBackup`, small
 * enough to be obviously correct and exercised by a test that round-trips a
 * real database through a real gzip file.
 *
 * Parsing goes through `fromCloudRow` — the same validator a pull uses — so the
 * restore path and the sync path share one parser, and a change that breaks one
 * breaks both loudly rather than one of them in a year's time.
 *
 * ── Restored rows are PENDING, not synced ───────────────────────────────────
 * `ingest()` marks what it writes as synced, because a pulled row is in the
 * cloud by definition. A restored row is the opposite: the reason anyone is
 * restoring is that something was lost, quite possibly the cloud itself
 * (`docs/IMPL_STORE_SYNC.md` §8 layer 1 — mark the rows unsynced and let the
 * flush loop rebuild the cloud). So a restore inserts with `synced_at_ms NULL`
 * and the next flush re-confirms every row, which is idempotent by
 * construction: the ids are client-minted and the Worker's insert is
 * ON CONFLICT DO NOTHING.
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { insertClosed, type CloudPayload } from "../store/intervals";
import { fromCloudRow } from "./wire";

/** Parse `wwb-YYYY-Www.ndjson.gz`. Blank lines are skipped; junk throws. */
export function readNdjsonGz(path: string): CloudPayload[] {
  return parseNdjson(gunzipSync(readFileSync(path)).toString("utf8"));
}

export function parseNdjson(text: string): CloudPayload[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        const raw = JSON.parse(line) as unknown;
        const hasSeq =
          typeof raw === "object" &&
          raw !== null &&
          typeof (raw as Record<string, unknown>)["seq"] === "number";
        // The export carries no `seq`: that number belongs to one particular
        // cloud database, and carrying this decade's value into next decade's
        // replacement backend would be a lie. Null means "not confirmed in this
        // cloud", which after a restore is precisely true.
        const payload = fromCloudRow(hasSeq ? raw : withSeq(raw));
        return hasSeq ? payload : { ...payload, cloudSeq: null };
      } catch (err) {
        throw new Error(
          `ndjson line ${String(i + 1)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

/**
 * Restore into any database — an empty one, or one that already holds some of
 * these rows. Insert-or-ignore, so restoring twice is a no-op and restoring
 * over live data cannot overwrite it. Returns the number of rows inserted.
 */
export function restoreNdjson(
  db: DatabaseSync,
  rows: readonly CloudPayload[],
): number {
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const ok = insertClosed(db, {
        ...r,
        // The cloud has no `last_signal_at_ms` column: `ended_at_ms` IS the
        // last signal. Re-deriving it is what lets the local CHECK constraint
        // hold over restored rows.
        lastSignalAtMs: r.endedAtMs,
        syncedAtMs: null,
      });
      if (ok) inserted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return inserted;
}

export function restoreNdjsonGz(db: DatabaseSync, path: string): number {
  return restoreNdjson(db, readNdjsonGz(path));
}

function withSeq(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  return { ...(raw as Record<string, unknown>), seq: 0 };
}
