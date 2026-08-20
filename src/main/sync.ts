/**
 * The wire between `src/sync/` and the running app.
 *
 * `src/sync/` was built as a set of pure-ish functions over a database handle
 * and a `WorkerClient` — flush, pull, fingerprint, backup, silence — with no
 * opinion about when any of them runs. This file is that opinion, and it is the
 * one the plan states:
 *
 *   flush()   interval close · `powerMonitor` resume · launch · backoff retry
 *   pull()    launch · wake · after each successful flush
 *   weekly    self-export, fingerprint reconciliation, silence alarm
 *
 * (`docs/ARCHITECTURE.md` §5, `docs/IMPL_STORE_SYNC.md` §5/§6/§8.)
 *
 * ── NOT CONFIGURED IS NOT AN ERROR ──────────────────────────────────────────
 * There is no Worker URL and no token until the owner creates a D1 database and
 * deploys the Worker. Everything below therefore has to work with `config ===
 * null`, and work means: no throw on the boot path, no network call, no timer,
 * nothing slower about closing an interval, and a doctor that says "not
 * configured" rather than inventing a failure. Tracking has never needed the
 * cloud — the mirror is the product, the cloud is a second copy.
 *
 * The one thing that still runs unconfigured is the **weekly local export**
 * (backup layer 2). It writes two files to iCloud Drive or `~/Documents`, needs
 * no network at all, and is the layer that makes leaving Cloudflare cheap. An
 * owner without a Worker deserves it more than one with, not less.
 *
 * ── SINGLE-FLIGHT COVERS THE WHOLE CYCLE, NOT JUST THE DRAIN ────────────────
 * `Flusher` is already single-flight over the drain. This adds a second guard
 * over drain-plus-pull, because `runCycle()` and a `flushNow()` from the tray
 * can land in the same millisecond on wake: without it the drain would be
 * shared and the pull would run twice.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ICLOUD_RELATIVE,
  backupDir as defaultBackupDir,
  HttpError,
  checkSilence,
  createFlusher,
  createWorkerClient,
  noteCloudWrite,
  pull,
  weeklyBackup,
  weeklyMaintenance,
  type BackupResult,
  type Flusher,
  type ReconcileReport,
  type SilenceState,
  type WorkerClient,
} from "../sync";
import { pendingCount } from "../store";
import { getSyncState, upsertMachine } from "../store/sync-state";
import type { FlushResult, SyncTestResult } from "../shared/ipc-types";
import { createDirectoryAccessGate, type DirectoryAccess } from "./file-access";
import { log } from "./log";
import {
  NOT_CONFIGURED,
  type SyncHealth,
  type SyncSeam,
  type SyncSnapshot,
} from "./sync-seam";

const DAY_MS = 86_400_000;

/** Resolved configuration. Both halves are required; neither has a default. */
export interface SyncConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export type ConfigResult =
  | { readonly config: SyncConfig; readonly error: null }
  | { readonly config: null; readonly error: string | null };

/**
 * Turn a stored URL and a decrypted token into a config, or say why not.
 *
 * A blank URL or a blank token is the ordinary unconfigured state and carries
 * no error. A URL that is present but not an http(s) URL is a typo the owner
 * needs to see: still `configured: false` — we will not call it — but with a
 * reason attached, because "not configured" with no explanation for a field you
 * know you filled in is the worst of the three states to be shown.
 */
export function resolveSyncConfig(workerUrl: string, token: string | null): ConfigResult {
  const baseUrl = workerUrl.trim();
  const secret = (token ?? "").trim();
  if (baseUrl === "" || secret === "") return { config: null, error: null };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { config: null, error: `worker URL is not a URL: ${baseUrl}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { config: null, error: `worker URL must be http(s), got ${parsed.protocol}` };
  }
  return { config: { baseUrl, token: secret }, error: null };
}

/**
 * Try a configuration without storing it — the "Test connection" button.
 *
 * TWO REQUESTS, NOT ONE, and the order is the diagnosis:
 *
 *  1. `GET /health` is unauthenticated (`worker/src/routes.ts` says so out
 *     loud). It answers "is this URL a deployed Worker this Mac can reach",
 *     which on the work Mac is a question about the corporate proxy and not
 *     about anything the owner typed.
 *  2. `GET /machines` is authenticated and reads nothing bigger than a handful
 *     of label rows. It is the only way to learn that the URL is perfect and
 *     the TOKEN is wrong — a distinction the owner cannot make from a single
 *     "it didn't work", and the most likely mistake of the two, because the
 *     Worker mints one token per Mac and swapping them looks identical.
 *
 * `/fingerprint` would also have proved the token, and it hashes every row id
 * in the database to do it. A button somebody presses while typing does not get
 * to be that expensive.
 *
 * Never throws. Every failure is a value with a sentence in it, because the
 * caller is a button and a rejected invoke renders as a stack trace.
 */
export async function probeSyncConfig(
  workerUrl: string,
  token: string | null,
  opts: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<SyncTestResult> {
  const nowMs = opts.now ?? Date.now;
  const started = nowMs();
  const resolved = resolveSyncConfig(workerUrl, token);
  if (resolved.config === null) {
    return {
      ok: false,
      reachable: false,
      authorized: false,
      status: null,
      ms: null,
      error:
        resolved.error ??
        (workerUrl.trim() === ""
          ? "enter the Worker URL first"
          : "enter this Mac's token first"),
    };
  }

  const client = createWorkerClient({
    baseUrl: resolved.config.baseUrl,
    token: resolved.config.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    // Shorter than the flusher's 20 s: this one has a human waiting on it, and
    // "still spinning" is a worse answer than "could not reach it".
    timeoutMs: opts.timeoutMs ?? 8000,
  });

  try {
    await client.health();
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      authorized: false,
      status: err instanceof HttpError ? err.status : null,
      ms: nowMs() - started,
      error: reachErrorOf(err, resolved.config.baseUrl),
    };
  }

  try {
    await client.getMachines();
  } catch (err) {
    const status = err instanceof HttpError ? err.status : null;
    return {
      ok: false,
      reachable: true,
      authorized: false,
      status,
      ms: nowMs() - started,
      error:
        status === 401 || status === 403
          ? "the Worker is reachable but rejected this token — each Mac gets its own, and swapping them fails exactly like this"
          : `the Worker is reachable but the authenticated read failed: ${messageOf(err)}`,
    };
  }

  return {
    ok: true,
    reachable: true,
    authorized: true,
    status: 200,
    ms: nowMs() - started,
    error: null,
  };
}

function reachErrorOf(err: unknown, baseUrl: string): string {
  if (err instanceof HttpError) {
    return `${baseUrl}/health answered ${String(err.status)} — that host is reachable but it is not this Worker`;
  }
  // A DNS failure, a refused connection, a proxy and an 8-second abort all land
  // here, and on the work Mac the proxy is the likely one. Say so: it is the
  // reason `/health` is unauthenticated in the first place.
  return `could not reach ${baseUrl} (${messageOf(err)}) — check the URL, and on a work Mac check whether the proxy allows workers.dev`;
}

export interface SyncServiceDeps {
  readonly db: DatabaseSync;
  /** null ⇒ not configured. Everything still runs; nothing touches the network. */
  readonly config: SyncConfig | null;
  /** Present when a URL or token was supplied but unusable. See `resolveSyncConfig`. */
  readonly configError?: string | null;
  /** This Mac's `IOPlatformUUID`. Stamps the local mirror of each heartbeat. */
  readonly machineId: string;
  /**
   * READ PER HEARTBEAT, never captured.
   *
   * A rename has to reach the cloud, and the app is not relaunched between the
   * rename and the next sync. Holding the label as a string here would send the
   * name this Mac had at boot for the rest of the session — the rename would
   * look applied locally and would never arrive on the other Mac.
   */
  readonly machineLabel?: () => string;
  readonly appVersion: string;
  readonly osVersion?: string;
  /** IANA zone, for the ISO week the backup filenames are keyed on. */
  readonly tz?: string;
  /** Overridden by the tests. Production takes the iCloud-or-Documents answer. */
  readonly backupDir?: string;
  /**
   * The gate that keeps the synchronous backup pass off a directory macOS has
   * not consented to yet — `src/main/file-access.ts`. Overridden by the tests,
   * which have no TCC prompt to wait for.
   */
  readonly backupAccess?: () => Promise<DirectoryAccess>;
  /** The async probe behind the default gate. Injected by the tests. */
  readonly accessProbe?: (dir: string) => Promise<unknown>;
  readonly now?: () => number;
  /** Injected by the tests, which route requests straight into the Worker. */
  readonly fetchImpl?: typeof fetch;
  /** The runtime's change fan-out, so the tray and the dashboard hear about it. */
  readonly onChange?: (kind: "sync" | "rows-pulled") => void;
}

export interface SyncService extends SyncSeam {
  readonly configured: boolean;
  /**
   * Launch and wake: flush, pull, heartbeat, then the weekly maintenance pass.
   * Never rejects and never throws — it is called with `void` from the boot
   * sequence, where an unhandled rejection would take the app down before it
   * had measured anything.
   */
  runCycle(reason: "launch" | "wake"): Promise<void>;
  /**
   * Push a heartbeat right now, outside the launch/wake cycle. A rename calls
   * this so the other Mac learns the new name in seconds rather than at the
   * next launch. Resolves `false` when it did not reach the cloud — offline, or
   * simply not configured — and never rejects, because neither of those is a
   * reason for a rename to fail.
   */
  heartbeatNow(): Promise<boolean>;
  /** Apply a configuration change without a relaunch. Stops the old flusher. */
  reconfigure(config: SyncConfig | null, error?: string | null): Promise<void>;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const { db, onChange } = deps;
  const nowMs = deps.now ?? Date.now;
  const dir = deps.backupDir ?? defaultBackupDir();
  // Asked once per process, on the threadpool. See `maintenance()` below and
  // `src/main/file-access.ts` for why this exists at all.
  const backupAccess =
    deps.backupAccess ??
    createDirectoryAccessGate(dir, {
      ...(deps.accessProbe === undefined ? {} : { probe: deps.accessProbe }),
    });

  function build(config: SyncConfig | null): {
    client: WorkerClient | null;
    flusher: Flusher | null;
  } {
    if (config === null) return { client: null, flusher: null };
    const c = createWorkerClient({
      baseUrl: config.baseUrl,
      token: config.token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return { client: c, flusher: createFlusher({ db, client: c, nowMs }) };
  }

  let { client, flusher } = build(deps.config);

  let lastFlushOkMs: number | null = null;
  let lastFlushError: string | null = deps.configError ?? null;
  let lastPullMs: number | null = null;
  let lastPullError: string | null = null;
  let lastReconcile: ReconcileReport | null = null;
  let backup: { path: string; atMs: number; kept: number } | null = null;
  let silence: SilenceState = { alarm: false, lastCloudWriteMs: null, ageMs: null };
  let inFlight: Promise<FlushResult> | null = null;

  function refreshSilence(atMs: number): boolean {
    const before = silence.alarm;
    silence = checkSilence(db, atMs);
    return silence.alarm !== before;
  }

  function watermark(): number {
    const raw = getSyncState(db, "pull_watermark");
    const parsed = raw === null ? 0 : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }

  function unconfiguredResult(atMs: number): FlushResult {
    return {
      ok: false,
      attempted: 0,
      confirmed: 0,
      pendingAfter: pendingCount(db),
      // Not a failure. `configured: false` in the doctor is the real answer;
      // this string is what the tray's "Sync now" shows a human.
      error: lastFlushError ?? NOT_CONFIGURED,
      atMs,
    };
  }

  /**
   * Drain, then pull. The pull runs only after a drain that did not error: a
   * flush that failed on a dead network would only produce a second failure,
   * and two error strings for one outage is noise, not information.
   */
  async function drainAndPull(f: Flusher, c: WorkerClient): Promise<FlushResult> {
    const at = nowMs();
    // `flusher.flush()` never rejects — a refusal and a failed fetch both come
    // back as a result carrying `error`.
    const res = await f.flush();

    if (res.error === undefined) {
      lastFlushOkMs = at;
      lastFlushError = null;
      try {
        const page = await pull(db, c);
        lastPullMs = nowMs();
        lastPullError = null;
        // Not fatal — labels are cosmetic and the intervals above are not — but
        // not silent either. A Worker that has not been redeployed with
        // `GET /machines` answers 404 here, and the symptom on the other Mac is
        // a machine that never stops rendering as a raw UUID.
        if (page.machinesError !== null) {
          log.warn(`machine labels not pulled: ${page.machinesError}`);
        }
        if (page.ingested > 0) onChange?.("rows-pulled");
      } catch (err) {
        lastPullError = messageOf(err);
        log.warn("pull failed", err);
      }
    } else {
      lastFlushError = res.error;
    }

    if (refreshSilence(nowMs())) onChange?.("sync");
    return {
      ok: res.error === undefined,
      attempted: res.attempted,
      confirmed: res.confirmed,
      pendingAfter: pendingCount(db),
      error: res.error ?? null,
      atMs: at,
    };
  }

  function flush(): Promise<FlushResult> {
    // Captured, not read again later: a `reconfigure()` landing mid-drain must
    // not swap the token out from under a request that is already in the air.
    const f = flusher;
    const c = client;
    if (f === null || c === null) {
      return Promise.resolve(unconfiguredResult(nowMs()));
    }
    if (inFlight !== null) return inFlight;
    inFlight = drainAndPull(f, c).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /**
   * Liveness, so the 72-hour alarm means something during a fortnight off.
   *
   * The alarm asks "is anything of ours reaching the cloud?" and an empty
   * outbox answers it with silence — which would otherwise trip an alarm that
   * means nothing at all. A heartbeat is the honest answer to that question.
   */
  async function heartbeat(): Promise<boolean> {
    const c = client;
    if (c === null) return false;
    const label = deps.machineLabel?.() ?? "";
    try {
      await c.heartbeat({
        ...(label === "" ? {} : { label }),
        ...(deps.osVersion === undefined ? {} : { osVersion: deps.osVersion }),
        appVersion: deps.appVersion,
      });
      const at = nowMs();
      noteCloudWrite(db, at);
      // The local mirror of what we just told the cloud, stamped `now`.
      //
      // This runs AFTER the pull in a cycle, and that ordering is the point: a
      // pull can carry back a machine row the cloud wrote before this rename
      // existed, and `upsertMachine` resolves that on `last_seen_ms`. Re-writing
      // here with the label we just successfully sent means a clock skew large
      // enough to let the stale cloud row win the pull is corrected inside the
      // same cycle rather than lingering until the next one.
      upsertMachine(db, {
        machineId: deps.machineId,
        ...(label === "" ? {} : { label }),
        ...(deps.osVersion === undefined ? {} : { osVersion: deps.osVersion }),
        appVersion: deps.appVersion,
        lastSeenMs: at,
      });
      return true;
    } catch (err) {
      // Best-effort by definition: it moves no interval and loses no row.
      log.warn("heartbeat failed", err);
      return false;
    }
  }

  /**
   * Backup layers 2, 3 and 4, in that order.
   *
   * Configured or not, the local export runs. Only the fingerprint check needs
   * the cloud, and `weeklyMaintenance` already declines to write its week
   * marker when the comparison could not complete, so an offline week retries
   * at the next launch instead of being skipped in silence.
   */
  async function maintenance(): Promise<void> {
    // EVERYTHING BELOW IS SYNCHRONOUS AND WRITES INTO `dir`, and `dir` is
    // iCloud Drive or ~/Documents — both TCC-protected. macOS answers the
    // first touch of a protected directory by BLOCKING the syscall until the
    // consent dialog is answered, and a blocked syscall here is a blocked
    // Electron main thread: no window can open, `second-instance` never fires,
    // and nothing logs, because nothing runs. That is exactly how the packaged
    // app shipped. `src/main/file-access.ts` has the full story; the rule is
    // that the WAIT happens on the threadpool and the synchronous work happens
    // only once macOS has an answer cached for this process.
    const access = await backupAccess();
    if (access === "undecided") {
      log.error(
        `backup skipped: macOS has not answered the file-access prompt for ${dir}. ` +
          `The app is running normally; grant access (or move the backup directory) ` +
          `and the next launch will export.`,
      );
      return;
    }
    const at = nowMs();
    const c = client;
    const opts = { nowMs: at, dir, ...(deps.tz === undefined ? {} : { tz: deps.tz }) };
    try {
      if (c === null) {
        recordBackup(weeklyBackup(db, opts), at);
      } else {
        const result = await weeklyMaintenance(db, c, {
          ...opts,
          onMismatch: (report) => {
            // Backup layer 3 is the only layer that catches SILENT loss, so
            // this is loud: a tray badge, a degraded reason, and a log line.
            log.error(
              `cloud fingerprint MISMATCH — local ${String(report.local.count)} rows vs cloud ` +
                `${String(report.remote.count)}, ${String(report.local.pending)} still pending`,
            );
          },
        });
        recordBackup(result.backup, at);
        if (result.reconcile !== null) lastReconcile = result.reconcile;
        if (result.reconcileError !== undefined) {
          log.warn(`weekly fingerprint check could not complete: ${result.reconcileError}`);
        }
      }
    } catch (err) {
      // A failed VACUUM or an unwritable iCloud directory is a backup problem,
      // never a reason for the app to stop measuring hours.
      log.error("weekly maintenance failed", err);
    }
    if (refreshSilence(nowMs())) onChange?.("sync");
  }

  /**
   * `weeklyBackup` returns null when this week's pair is already on disk, which
   * is the common case since the app launches every day. Ask the filesystem
   * instead of reporting "never backed up" for a machine that backs up weekly.
   */
  function recordBackup(result: BackupResult | null, atMs: number): void {
    if (result !== null) {
      backup = { path: result.written[0] ?? dir, atMs, kept: countBackups(dir) };
      return;
    }
    backup = latestBackup(dir);
  }

  async function runCycle(reason: "launch" | "wake"): Promise<void> {
    try {
      const res = await flush();
      if (res.ok) await heartbeat();
      await maintenance();
      onChange?.("sync");
    } catch (err) {
      // Nothing above is supposed to reject. If something does, it is a bug in
      // this file and not a reason to lose the boot sequence.
      log.error(`sync cycle (${reason}) failed`, err);
    }
  }

  function health(): SyncHealth {
    return {
      configured: client !== null,
      silentForMs: silence.ageMs,
      fingerprintMatched: lastReconcile === null ? null : lastReconcile.status === "match",
    };
  }

  function snapshot(): SyncSnapshot {
    const at = nowMs();
    refreshSilence(at);
    return {
      sync: {
        configured: client !== null,
        pendingRows: pendingCount(db),
        lastFlushOkMs,
        lastFlushError,
        lastPullMs,
        lastPullError,
        watermark: watermark(),
        lastCloudWriteMs: silence.lastCloudWriteMs,
        silentForMs: silence.ageMs,
      },
      fingerprint:
        lastReconcile === null
          ? {
              checkedAtMs: null,
              matched: null,
              localCount: null,
              cloudCount: null,
              localSha: null,
              cloudSha: null,
            }
          : {
              checkedAtMs: lastReconcile.checkedAtMs,
              matched: lastReconcile.status === "match",
              localCount: lastReconcile.local.count,
              cloudCount: lastReconcile.remote.count,
              localSha: lastReconcile.local.sha256,
              cloudSha: lastReconcile.remote.sha256,
            },
      backup:
        backup === null
          ? { lastPath: null, lastAtMs: null, ageDays: null, destination: null, kept: 0 }
          : {
              lastPath: backup.path,
              lastAtMs: backup.atMs,
              ageDays: Math.max(0, Math.floor((at - backup.atMs) / DAY_MS)),
              destination: destinationOf(dir),
              kept: backup.kept,
            },
    };
  }

  return {
    get configured() {
      return client !== null;
    },
    flush,
    runCycle,
    heartbeatNow: heartbeat,
    health,
    snapshot,
    pollSilence(atMs: number): void {
      if (refreshSilence(atMs)) onChange?.("sync");
    },
    async stop(): Promise<void> {
      await flusher?.stop();
    },

    /**
     * The owner pasted a token, or fixed a typo in the URL.
     *
     * Rebuilds the client and the flusher in place so the app does not have to
     * be relaunched to become configured — an app that says "not configured"
     * for the rest of the session after you configured it is a bug report.
     * The old flusher is STOPPED, not merely dropped: its backoff timer and any
     * drain still in flight both belong to a token that is no longer current.
     */
    async reconfigure(config: SyncConfig | null, error: string | null = null): Promise<void> {
      const previous = flusher;
      ({ client, flusher } = build(config));
      inFlight = null;
      lastFlushError = error;
      await previous?.stop();
    },
  };
}

const SQLITE_RE = /^wwb-\d{4}-W\d{2}\.sqlite$/;

/** Newest weekly export on disk, by filename — 'YYYY-Www' sorts chronologically. */
export function latestBackup(dir: string): { path: string; atMs: number; kept: number } | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => SQLITE_RE.test(n));
  } catch {
    // No backup directory yet is the first-run state, not a failure.
    return null;
  }
  const newest = names.sort().at(-1);
  if (newest === undefined) return null;
  const path = join(dir, newest);
  try {
    return { path, atMs: statSync(path).mtimeMs, kept: names.length };
  } catch {
    return null;
  }
}

function countBackups(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => SQLITE_RE.test(n)).length;
  } catch {
    return 0;
  }
}

function destinationOf(dir: string): "icloud" | "documents" {
  return dir.includes(ICLOUD_RELATIVE) ? "icloud" : "documents";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
