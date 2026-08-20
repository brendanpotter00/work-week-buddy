/**
 * Backup layer 3 — the only layer that catches *silent* loss.
 *
 * Without it the other three are theatre, because nobody ever learns they were
 * needed. Once a week the mirror hashes the rows it believes the cloud holds,
 * asks the cloud for the same number, and compares.
 *
 * ── THE HASH IS DEFINED IN `worker/src/fingerprint.ts`, ONCE ────────────────
 * Copied verbatim, never paraphrased — a client and a server that disagree
 * about the joining character produce a permanent, unexplained mismatch alarm
 * that looks exactly like real data loss:
 *
 *   lowercase hex SHA-256 of every `id`, sorted ASCII-ascending,
 *   joined with "\n", no trailing newline, encoded UTF-8.
 *
 * An empty set hashes the empty string — e3b0c442…b855, a real value and not a
 * special case.
 *
 * `node:crypto` is used here rather than `crypto.subtle`, which the Worker
 * uses. That is deliberate: two independent implementations of one spec agree
 * only if the spec was followed, so the cross-check test is worth something.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { n, s, type Row } from "../store/coerce";
import type { CloudFingerprint, WorkerClient } from "./client";

export interface LocalFingerprint {
  readonly count: number;
  readonly maxEndedAtMs: number;
  readonly sha256: string;
  /** Rows not yet uploaded. A mismatch with pending > 0 is expected, not loss. */
  readonly pending: number;
}

export type ReconcileStatus = "match" | "mismatch";

export interface ReconcileReport {
  readonly status: ReconcileStatus;
  readonly local: LocalFingerprint;
  readonly remote: CloudFingerprint;
  /** Positive when the cloud holds fewer rows than we believe it does. */
  readonly missingFromCloud: number;
  readonly checkedAtMs: number;
}

/** The canonical digest. Byte-identical to `worker/src/fingerprint.ts`. */
export function fingerprintSha256(ids: readonly string[]): string {
  // Sorted here rather than trusted from a query's ORDER BY, so the digest is
  // independent of insert order and of collation — the property the whole
  // check rests on. UUIDv7 ids are ASCII, where JS's UTF-16 code-unit sort,
  // ASCII-ascending and SQLite's BINARY collation all coincide.
  const canonical = [...ids].sort().join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The mirror's view of what the cloud holds: rows this machine has confirmed
 * synced, which after a pull includes the other Mac's rows too.
 *
 * Restricted to `synced_at_ms IS NOT NULL` on purpose. Hashing every local row
 * would report a mismatch for anything merely sitting in the outbox, and an
 * alarm that cries wolf during a normal offline hour is an alarm that gets
 * ignored in the month it finally matters.
 */
export function localFingerprint(db: DatabaseSync): LocalFingerprint {
  const rows = db
    .prepare(
      `SELECT id, ended_at_ms FROM work_interval
        WHERE synced_at_ms IS NOT NULL ORDER BY id`,
    )
    .all() as Row[];
  const pendingRow = db
    .prepare(`SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NULL`)
    .get() as Row;
  const ids = rows.map((r) => s(r, "id"));
  return {
    count: ids.length,
    maxEndedAtMs: rows.reduce((m, r) => Math.max(m, n(r, "ended_at_ms")), 0),
    sha256: fingerprintSha256(ids),
    pending: n(pendingRow, "c"),
  };
}

export interface ReconcileOptions {
  readonly nowMs?: () => number;
  /** Tray badge and log line live in `src/main/`; this is the seam. */
  readonly onMismatch?: (report: ReconcileReport) => void;
}

/**
 * Compare, and report. Never repairs anything on its own.
 *
 * A repair is `UPDATE work_interval SET synced_at_ms = NULL` followed by a
 * flush — cheap, safe, and idempotent — but it is a decision a human makes
 * after reading what mismatched, not something a weekly job does at 3am to a
 * database it has just decided it does not understand.
 *
 * Run it after a flush and a pull have both completed, or a perfectly healthy
 * machine mid-sync will report a mismatch. `report.local.pending` says whether
 * that is what happened.
 */
export async function reconcile(
  db: DatabaseSync,
  client: WorkerClient,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const nowMs = opts.nowMs ?? Date.now;
  const local = localFingerprint(db);
  const remote = await client.fingerprint();
  const status: ReconcileStatus =
    local.sha256 === remote.sha256 && local.count === remote.count ? "match" : "mismatch";
  const report: ReconcileReport = {
    status,
    local,
    remote,
    missingFromCloud: local.count - remote.count,
    checkedAtMs: nowMs(),
  };
  if (status === "mismatch") opts.onMismatch?.(report);
  return report;
}
