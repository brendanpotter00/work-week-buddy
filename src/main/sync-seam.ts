/**
 * The vocabulary the runtime and the sync service share, and nothing else.
 *
 * It lives in its own file so `runtime.ts` never imports `sync.ts` and
 * `sync.ts` never imports `runtime.ts`: the runtime is handed a seam by
 * `bootstrap.ts` and has no idea a Cloudflare Worker exists. That is what keeps
 * `runtime.test.ts` able to drive the whole tracker with a two-method fake.
 *
 * ── THREE STATES, NOT TWO ───────────────────────────────────────────────────
 * "healthy", "failing" and **"not configured"** are different answers and the
 * shapes below keep them different. Until a Worker URL and a token exist there
 * is nothing to fail: `configured` is false, every timestamp is null, and the
 * doctor says so in those words. An owner who has not created his D1 database
 * yet must never see a red error about a network he never asked us to reach.
 */
import type { DatabaseSync } from "node:sqlite";
import { pendingCount } from "../store";
import type { DoctorReport, FlushResult } from "../shared/ipc-types";

/**
 * What `flushNow()` answers with when there is no URL and no token.
 *
 * It replaces the "sync is not wired into this build yet" placeholder that
 * stood here while `src/sync/` was being built in parallel. The wire is in;
 * what can still be missing is the owner's configuration.
 */
export const NOT_CONFIGURED = "sync is not configured";

/**
 * The cheap half. Read on every tray refresh through `degraded()`, so it is
 * cached values only — no query, no filesystem, no clock beyond what the
 * service already knows.
 */
export interface SyncHealth {
  /** False until both a Worker URL and a token exist. */
  readonly configured: boolean;
  /** Age of the last confirmed cloud write, or null if there has never been one. */
  readonly silentForMs: number | null;
  /** null = never checked. False = backup layer 3 found silent loss. */
  readonly fingerprintMatched: boolean | null;
}

/** The doctor's three sync sections, filled in from the real sync layer. */
export interface SyncSnapshot {
  readonly sync: DoctorReport["sync"];
  readonly fingerprint: DoctorReport["fingerprint"];
  readonly backup: DoctorReport["backup"];
}

export interface SyncSeam {
  /**
   * Drain the outbox, and pull on success. Never rejects: the mirror IS the
   * outbox, so a failed flush loses nothing and must not propagate into a
   * tracking path.
   */
  flush(): Promise<FlushResult>;
  /** Cached. Called on every tray refresh. */
  health(): SyncHealth;
  /** The doctor's view. Reads the database; called rarely. */
  snapshot(): SyncSnapshot;
  /**
   * The 72-hour silence alarm, checked on the existing five-minute watchdog
   * tick because it is a read of one integer and does not deserve a sixth timer.
   */
  pollSilence(nowMs: number): void;
  /**
   * Disarm the backoff timer and WAIT for any drain already running. The only
   * safe thing to call before the database is closed.
   */
  stop(): Promise<void>;
}

/**
 * The seam a runtime gets when no sync service was attached.
 *
 * A null object rather than a `null` check on every call site: an app with no
 * Worker URL and an app built without the sync service are the same fact — the
 * cloud is not reachable and nothing is pending against it — so they get the
 * same answers. It reads the outbox (that number is true either way) and
 * touches nothing else: no network, no timer, no filesystem.
 */
export function unconfiguredSync(db: DatabaseSync, nowMs: () => number): SyncSeam {
  return {
    flush: () =>
      Promise.resolve({
        ok: false,
        attempted: 0,
        confirmed: 0,
        pendingAfter: pendingCount(db),
        error: NOT_CONFIGURED,
        atMs: nowMs(),
      }),
    health: () => ({ configured: false, silentForMs: null, fingerprintMatched: null }),
    snapshot: () => ({
      sync: {
        configured: false,
        pendingRows: pendingCount(db),
        lastFlushOkMs: null,
        lastFlushError: null,
        lastPullMs: null,
        lastPullError: null,
        watermark: 0,
        lastCloudWriteMs: null,
        silentForMs: null,
      },
      fingerprint: {
        checkedAtMs: null,
        matched: null,
        localCount: null,
        cloudCount: null,
        localSha: null,
        cloudSha: null,
      },
      backup: { lastPath: null, lastAtMs: null, ageDays: null, destination: null, kept: 0 },
    }),
    pollSilence: () => undefined,
    stop: () => Promise.resolve(),
  };
}
