/**
 * The outbox drain. This is the file AGENTS.md #8 is about.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A row becomes `synced_at_ms = <now>` for exactly one reason: its id came back
 * in the `present` list of a parsed HTTP 200. Never on `response.ok` alone,
 * never on an insert count, never optimistically before the await.
 *
 * That is what makes a lost response harmless. If the server commits and the
 * response never arrives, the rows stay pending, the retry re-sends identical
 * client-minted ids, `ON CONFLICT(id) DO NOTHING` no-ops, and the Worker's
 * read-back still reports them present — so they are marked on the next
 * attempt instead of being uploaded forever or, far worse, marked when they
 * never landed.
 *
 * ── The timer ───────────────────────────────────────────────────────────────
 * Backoff is 30s → 1m → 2m → 4m → 8m → 15m with ±20% jitter, and the timer
 * EXISTS ONLY WHILE pending > 0. An idle app has no sync timer at all — see
 * `docs/IMPL_TASKS_EXPANDED.md` §6.5, which lists the complete set of five
 * timers this app is allowed to have. A drained outbox clears the timer and
 * resets the delay in the same breath.
 *
 * A failed fetch IS the network signal. There is no reachability check, no
 * `navigator.onLine`, no ping, and there must never be one.
 */
import type { DatabaseSync } from "node:sqlite";
import { markSynced, pendingRows } from "../store/intervals";
import { setSyncState } from "../store/sync-state";
import { MAX_ROWS_PER_REQUEST, type PostResult, type WorkerClient } from "./client";

/** One page of the outbox is one request. The Worker's cap, and ours. */
export const FLUSH_PAGE_SIZE = MAX_ROWS_PER_REQUEST;

export const BACKOFF_START_MS = 30_000;
export const BACKOFF_CAP_MS = 900_000;
/** ±20%: the delay lands in [0.8, 1.2] × the step. */
export const BACKOFF_JITTER = 0.2;

/** The full ladder, for the test that pins it and for the doctor CLI. */
export const BACKOFF_LADDER_MS: readonly number[] = [
  30_000, 60_000, 120_000, 240_000, 480_000, 900_000,
];

export interface FlushResult {
  /** Rows sent, counting a page twice if it was re-sent. */
  readonly attempted: number;
  /** Rows the server reported present, i.e. rows now marked. */
  readonly confirmed: number;
  /** True when the outbox reached zero on this run. */
  readonly drained: boolean;
  /** Present only when the run stopped early. */
  readonly error?: string | undefined;
  /** Milliseconds until the armed retry, or null when nothing is armed. */
  readonly retryInMs?: number | undefined;
}

export type FlushEvent =
  | { readonly kind: "sent"; readonly rows: number }
  | { readonly kind: "confirmed"; readonly rows: number }
  | { readonly kind: "failed"; readonly error: string; readonly pending: number }
  | { readonly kind: "no_progress"; readonly rows: number }
  | { readonly kind: "retry_armed"; readonly delayMs: number }
  | { readonly kind: "drained" };

/** Whatever the injected scheduler hands back. `setTimeout`'s handle, in prod. */
export type TimerHandle = unknown;

export interface FlusherDeps {
  readonly db: DatabaseSync;
  readonly client: WorkerClient;
  readonly nowMs?: () => number;
  readonly scheduleTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimer?: (handle: TimerHandle) => void;
  /** Injected so the jitter band can be asserted rather than sampled. */
  readonly random?: () => number;
  readonly pageSize?: number;
  readonly onEvent?: (event: FlushEvent) => void;
}

export interface Flusher {
  /**
   * Drain the outbox. Single-flight: a call made while one is running returns
   * the running one rather than opening a second connection over the same rows.
   *
   * Called on interval close, on `powerMonitor` resume, at launch after
   * recovery, and from the backoff timer. Nowhere else.
   */
  flush(): Promise<FlushResult>;
  /** True while a retry is armed. False the moment the outbox is empty. */
  timerArmed(): boolean;
  /** The delay of the armed retry, or null. */
  armedDelayMs(): number | null;
  /** The next backoff step, before jitter. 0 when the ladder is reset. */
  backoffMs(): number;
  hasPending(): boolean;
  /** Disarm on quit. Idempotent. */
  cancel(): void;
}

function defaultSchedule(fn: () => void, delayMs: number): TimerHandle {
  const handle: ReturnType<typeof setTimeout> = setTimeout(fn, delayMs);
  // A pending retry must not be a reason for the process to stay alive: the
  // app's own lifecycle decides that, and a CLI run must be able to exit.
  handle.unref?.();
  return handle;
}

function defaultCancel(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export function createFlusher(deps: FlusherDeps): Flusher {
  const {
    db,
    client,
    nowMs = Date.now,
    scheduleTimer = defaultSchedule,
    cancelTimer = defaultCancel,
    random = Math.random,
    pageSize = FLUSH_PAGE_SIZE,
    onEvent,
  } = deps;

  let inFlight: Promise<FlushResult> | null = null;
  let timer: TimerHandle | null = null;
  let armedDelay: number | null = null;
  let backoff = 0;

  const emit = (event: FlushEvent): void => onEvent?.(event);

  const hasPending = (): boolean => pendingRows(db, 1).length > 0;

  function disarm(): void {
    if (timer !== null) cancelTimer(timer);
    timer = null;
    armedDelay = null;
  }

  /** Clears the timer AND resets the ladder. Only a drained outbox does this. */
  function resetBackoff(): void {
    disarm();
    backoff = 0;
  }

  function scheduleRetry(): number | null {
    // The timer exists only while there is work for it. Arming one over an
    // empty outbox is how an app ends up with a heartbeat it never asked for.
    if (!hasPending()) {
      resetBackoff();
      return null;
    }
    disarm();
    backoff = backoff === 0 ? BACKOFF_START_MS : Math.min(backoff * 2, BACKOFF_CAP_MS);
    const delay = Math.round(
      backoff * (1 - BACKOFF_JITTER + random() * (2 * BACKOFF_JITTER)),
    );
    armedDelay = delay;
    timer = scheduleTimer(() => {
      timer = null;
      armedDelay = null;
      void flush();
    }, delay);
    emit({ kind: "retry_armed", delayMs: delay });
    return delay;
  }

  async function drain(): Promise<FlushResult> {
    let attempted = 0;
    let confirmed = 0;
    for (;;) {
      const rows = pendingRows(db, pageSize);
      if (rows.length === 0) {
        // Drained. The timer dies with the queue.
        resetBackoff();
        emit({ kind: "drained" });
        return { attempted, confirmed, drained: true };
      }

      attempted += rows.length;
      emit({ kind: "sent", rows: rows.length });

      let result: PostResult;
      try {
        result = await client.postIntervals(rows);
      } catch (err) {
        // Offline, DNS, TLS, timeout, 401, 413, 500 — all the same thing to
        // this loop: nothing was confirmed, so nothing is marked, and every row
        // is still in the outbox for the retry.
        const error = err instanceof Error ? err.message : String(err);
        emit({ kind: "failed", error, pending: rows.length });
        const retryInMs = scheduleRetry() ?? undefined;
        return { attempted, confirmed, drained: false, error, retryInMs };
      }

      // ── Past this line, and only past this line, a 200 has been parsed. ──
      const at = nowMs();
      markSynced(db, result.present, at);

      const sent = new Set(rows.map((r) => r.id));
      const landed = result.present.filter((p) => sent.has(p.id)).length;
      confirmed += landed;
      emit({ kind: "confirmed", rows: landed });

      if (landed > 0) {
        // Only a row that actually landed is evidence the cloud is accepting
        // writes. That is what the 72-hour silence alarm reads.
        setSyncState(db, "last_cloud_write_ms", String(at));
      } else {
        // A 200 that confirms nothing means the page would be re-sent forever.
        // Stop and back off instead of spinning on the same rows.
        emit({ kind: "no_progress", rows: rows.length });
        const retryInMs = scheduleRetry() ?? undefined;
        return {
          attempted,
          confirmed,
          drained: false,
          error: "server confirmed no rows",
          retryInMs,
        };
      }
    }
  }

  function flush(): Promise<FlushResult> {
    if (inFlight !== null) return inFlight;
    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    flush,
    timerArmed: () => timer !== null,
    armedDelayMs: () => armedDelay,
    backoffMs: () => backoff,
    hasPending,
    cancel: resetBackoff,
  };
}

/**
 * Record contact with the cloud that was not an interval upload.
 *
 * The silence alarm asks "is anything of ours reaching the cloud?", so a
 * successful heartbeat answers it just as well as an upload does — and without
 * this, a fortnight off work with an empty outbox would trip a 72-hour alarm
 * that means nothing. Callers in `src/main/` call it after a heartbeat.
 */
export function noteCloudWrite(db: DatabaseSync, atMs: number): void {
  setSyncState(db, "last_cloud_write_ms", String(atMs));
}
