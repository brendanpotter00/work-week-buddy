/**
 * The pull watermark — AGENTS.md #9's home.
 *
 * ── THE 200-ROW OVERLAP IS NOT OPTIONAL ─────────────────────────────────────
 * `seq` is an `AUTOINCREMENT` identity. Under concurrent inserts, identity
 * values become *visible* out of order: a reader can see seq 105 committed
 * while 104 is still in flight. A strict `seq > watermark` therefore advances
 * past 105 and skips 104 **permanently** — silently, with nothing to notice and
 * no way to find it later.
 *
 * So every pull starts 200 rows behind the stored watermark. `ingest()` is
 * `INSERT … ON CONFLICT DO NOTHING`, which makes re-reading those rows free:
 * arriving twice, out of order, or three weeks late are all the same thing.
 * The test named for this must not be deleted.
 *
 * The dashboard never reads the cloud. A menu-bar popover has to paint in under
 * 16 ms, has to work on a plane, and has to work while a VPN is down — so the
 * cloud is a reconciliation target and never a render path. `pull()` runs at
 * launch, on wake, and after a successful flush. Nowhere else. No realtime, no
 * subscription.
 */
import type { DatabaseSync } from "node:sqlite";
import { ingest } from "../store/intervals";
import { getSyncState, setSyncState, upsertMachine } from "../store/sync-state";
import { MAX_PULL_LIMIT, type WorkerClient } from "./client";

/** Rows re-read behind the watermark on every pull. Never lower this. */
export const PULL_OVERLAP = 200;

/** One page. The Worker clamps to the same number. */
export const PULL_PAGE_SIZE = MAX_PULL_LIMIT;

export interface PullResult {
  /** Rows that were new to this mirror. Re-reads count zero, by design. */
  readonly ingested: number;
  /** Rows received, including the deliberate overlap. */
  readonly received: number;
  readonly watermark: number;
  readonly pages: number;
  /** Machine rows read from `GET /machines` and upserted. */
  readonly machines: number;
  /**
   * Why the machine read did not happen, or `null` when it did.
   *
   * Reported rather than thrown, and reported rather than swallowed. The
   * machine table carries LABELS; `work_interval` carries the data. An app
   * updated ahead of its Worker gets a 404 here, and failing the whole pull on
   * that would stop the other Mac's *hours* arriving over a cosmetic route.
   * `src/main/sync.ts` logs this, so it is visible rather than silent.
   */
  readonly machinesError: string | null;
}

export interface PullOptions {
  readonly nowMs?: () => number;
  readonly pageSize?: number;
}

export async function pull(
  db: DatabaseSync,
  client: WorkerClient,
  opts: PullOptions = {},
): Promise<PullResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const pageSize = opts.pageSize ?? PULL_PAGE_SIZE;

  const stored = readWatermark(db);
  let watermark = stored;
  // ── The overlap. Not an optimization to be removed later. ──
  let since = Math.max(0, stored - PULL_OVERLAP);
  let ingested = 0;
  let received = 0;
  let pages = 0;

  for (;;) {
    const page = await client.getIntervals(since, pageSize);
    pages++;
    if (page.rows.length === 0) break;

    received += page.rows.length;
    ingested += ingest(db, page.rows, nowMs());

    const maxSeq = page.rows.reduce((m, r) => Math.max(m, r.cloudSeq ?? 0), 0);
    if (maxSeq > watermark) {
      watermark = maxSeq;
      // Persisted per page, not at the end: a crash mid-pull must not re-read
      // from a stale watermark, and it must never skip forward past one.
      setSyncState(db, "pull_watermark", String(watermark));
    }

    // A short page means the cloud has nothing further; a full page means keep
    // going. `maxSeq <= since` would be a server that ignored `since`, and
    // paging on it would spin forever — stop instead.
    if (page.rows.length < pageSize || maxSeq <= since) break;
    since = maxSeq;
  }

  const labels = await pullMachines(db, client);

  return { ingested, received, watermark, pages, ...labels };
}

/**
 * The other Mac's name.
 *
 * `work_interval` stores `machine_id` and never the label, so a pulled row is
 * anonymous until the machine row that names it arrives. This is where it
 * arrives. `upsertMachine` decides conflicts on `last_seen_ms`, which is what
 * stops a stale cloud row reverting a rename this Mac made while offline —
 * the rename stamped a newer `last_seen_ms` than the heartbeat it has not
 * managed to send yet.
 *
 * `lastSeenMs` is the CLOUD's value, not `now()`. Stamping the read instant
 * here would make every pulled row look freshly alive and would make the
 * conflict rule meaningless, since the last reader would always win.
 */
async function pullMachines(
  db: DatabaseSync,
  client: WorkerClient,
): Promise<{ machines: number; machinesError: string | null }> {
  let rows;
  try {
    rows = await client.getMachines();
  } catch (err) {
    return { machines: 0, machinesError: err instanceof Error ? err.message : String(err) };
  }
  for (const m of rows) {
    upsertMachine(db, {
      machineId: m.machineId,
      ...(m.label === null ? {} : { label: m.label }),
      ...(m.osVersion === null ? {} : { osVersion: m.osVersion }),
      ...(m.appVersion === null ? {} : { appVersion: m.appVersion }),
      lastSeenMs: m.lastSeenMs,
    });
  }
  return { machines: rows.length, machinesError: null };
}

/**
 * A watermark that is not a finite non-negative number reads as 0.
 *
 * Zero costs one extra pull of history — every row re-read, every one of them
 * an `INSERT OR IGNORE` no-op. Trusting a corrupt value instead would skip
 * everything below it, forever. When the two failure modes are "slow once" and
 * "silently lose the year", pick slow.
 */
function readWatermark(db: DatabaseSync): number {
  const raw = getSyncState(db, "pull_watermark");
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}
