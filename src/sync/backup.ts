/**
 * Backup layers 2 and 4: the weekly self-export, and the 72-hour silence alarm.
 *
 * Layer 2 is load-bearing, not nice-to-have. D1's free Time Travel window is
 * seven days, so a mistake noticed on day eight is a mistake that is permanent
 * unless a file was written somewhere the vendor does not control.
 *
 * Two files, every week:
 *
 *   wwb-YYYY-Www.sqlite      a VACUUM INTO of the mirror — restore by copying
 *   wwb-YYYY-Www.ndjson.gz   one JSON object per interval, sorted by id
 *
 * **The NDJSON is the one that matters.** It restores into any future backend,
 * which is what makes leaving Cloudflare cheap. A `.sqlite` dump alone is a
 * vendor-shaped artifact that happens to be a different vendor's shape.
 *
 * ── Why the week marker is a file and not a database row ────────────────────
 * `docs/IMPL_TASKS_EXPANDED.md` §T4.4 keys the cadence on a
 * `sync_state.last_backup_week` row. This uses the presence of the week's own
 * files instead, for three reasons: `SyncKey` in the committed
 * `src/store/sync-state.ts` is a closed union of the two keys sync owns, and
 * this task owns `src/sync/` only; a row that says "backed up" while the file
 * has been deleted is a lie that hides itself; and a mirror restored from an
 * older copy would otherwise skip the week it is missing. The filesystem is the
 * thing being asserted about, so ask the filesystem.
 *
 * Both files are written to a temporary name and renamed into place, so a crash
 * mid-write cannot leave a truncated file that then convinces next launch the
 * week is already done.
 */
import { gzipSync } from "node:zlib";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { addDays, dayOfWeek, localDateOf } from "../store/dates";
import { getSyncState } from "../store/sync-state";
import type { WorkerClient } from "./client";
import { reconcile, type ReconcileReport } from "./fingerprint";
import { toWireRow, type WireRow } from "./wire";
import type { IntervalRow } from "../store/intervals";
import { n, nOrNull, s, type Row } from "../store/coerce";

/** One year of weekly pairs. */
export const KEEP_BACKUPS = 52;

/** `last_cloud_write_ms` older than this and the tray icon changes. */
export const SILENCE_MS = 72 * 60 * 60_000;

/** iCloud Drive, when the user has it turned on. */
export const ICLOUD_RELATIVE = "Library/Mobile Documents/com~apple~CloudDocs";

const FILE_RE = /^wwb-(\d{4}-W\d{2})\.(sqlite|ndjson\.gz)$/;

/** 'YYYY-Www' — the ISO 8601 week, which is what the filenames sort by. */
export function isoWeekOf(ms: number, tz: string = systemTz()): string {
  const date = localDateOf(ms, tz);
  // ISO weeks belong to the year containing their Thursday, which is the only
  // reason this is not `Math.floor(dayOfYear / 7)`. Late December and early
  // January are the two weeks where the difference is visible.
  const mondayOffset = (dayOfWeek(date) + 6) % 7;
  const thursday = addDays(date, 3 - mondayOffset);
  const isoYear = Number(thursday.slice(0, 4));
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((civilMs(thursday) - jan1) / (7 * 86_400_000)) + 1;
  return `${String(isoYear).padStart(4, "0")}-W${String(week).padStart(2, "0")}`;
}

/**
 * iCloud Drive if it exists and is writable, else `~/Documents/WorkWeekBuddy/
 * backups`. Nothing is ever typed by hand, and nothing prompts.
 */
export function backupDir(home: string = homedir()): string {
  const icloud = join(home, ICLOUD_RELATIVE);
  if (isWritableDir(icloud)) return join(icloud, "WorkWeekBuddy");
  return join(home, "Documents", "WorkWeekBuddy", "backups");
}

export interface BackupResult {
  readonly week: string;
  readonly dir: string;
  /** Absolute paths, sqlite first. */
  readonly written: string[];
  readonly rows: number;
  /** Files removed by the keep-52 rule. Files, never database rows. */
  readonly pruned: string[];
}

export interface BackupOptions {
  readonly nowMs?: number;
  /** Overridden by the tests; production takes the iCloud-or-Documents answer. */
  readonly dir?: string;
  readonly tz?: string;
  readonly keep?: number;
}

/**
 * Runs at the first launch of each ISO week, not on a timer.
 *
 * Returns null when this week's pair is already on disk — which is the common
 * case, since the app launches every day.
 */
export function weeklyBackup(
  db: DatabaseSync,
  opts: BackupOptions = {},
): BackupResult | null {
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.tz ?? systemTz();
  const dir = opts.dir ?? backupDir();
  const keep = opts.keep ?? KEEP_BACKUPS;
  const week = isoWeekOf(nowMs, tz);

  const sqlitePath = join(dir, `wwb-${week}.sqlite`);
  const ndjsonPath = join(dir, `wwb-${week}.ndjson.gz`);
  if (existsSync(sqlitePath) && existsSync(ndjsonPath)) return null;

  mkdirSync(dir, { recursive: true });

  // VACUUM INTO refuses to overwrite, and a half-written file from a previous
  // crash would otherwise wedge the backup permanently.
  const sqliteTmp = `${sqlitePath}.tmp`;
  rmSync(sqliteTmp, { force: true });
  db.prepare("VACUUM INTO ?").run(sqliteTmp);
  renameSync(sqliteTmp, sqlitePath);

  const rows = exportRows(db);
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
  const ndjsonTmp = `${ndjsonPath}.tmp`;
  writeFileSync(ndjsonTmp, gzipSync(Buffer.from(`${ndjson}${rows.length > 0 ? "\n" : ""}`, "utf8")));
  renameSync(ndjsonTmp, ndjsonPath);

  return {
    week,
    dir,
    written: [sqlitePath, ndjsonPath],
    rows: rows.length,
    pruned: prune(dir, keep),
  };
}

/**
 * Every interval, in wire shape, sorted by id.
 *
 * Wire shape rather than the local row shape so the export restores through the
 * same `fromCloudRow` path a pull uses — one parser, exercised weekly, instead
 * of a second one written the day it is needed. Sorted by id so two exports of
 * the same data are the same bytes.
 */
export function exportRows(db: DatabaseSync): WireRow[] {
  const raw = db.prepare(`SELECT * FROM work_interval ORDER BY id`).all();
  return raw.map((r) => toWireRow(rowOf(r as Row)));
}

/** Keep the newest `keep` of each kind. Filenames sort chronologically. */
function prune(dir: string, keep: number): string[] {
  const byKind = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (m === null) continue;
    const kind = m[2] as string;
    byKind.set(kind, [...(byKind.get(kind) ?? []), name]);
  }
  const pruned: string[] = [];
  for (const names of byKind.values()) {
    // 'YYYY-Www' is zero-padded, so lexicographic order is chronological order.
    const sorted = [...names].sort();
    for (const name of sorted.slice(0, Math.max(0, sorted.length - keep))) {
      const path = join(dir, name);
      // Backup files are files. The never-delete rule is about interval rows,
      // and there is not one of those in this function.
      rmSync(path, { force: true });
      pruned.push(path);
    }
  }
  return pruned.sort();
}

export interface SilenceState {
  /** True once nothing of ours has reached the cloud for 72 hours. */
  readonly alarm: boolean;
  readonly lastCloudWriteMs: number | null;
  readonly ageMs: number | null;
}

/**
 * Layer 4. Checked on the existing five-minute watchdog tick — it is a read of
 * one integer, so it belongs there rather than in a sixth timer.
 *
 * A mirror that has never written to the cloud does not alarm: on a fresh
 * install there is nothing to be silent about, and onboarding already reports
 * an unconfigured token. The alarm exists for the machine that worked for two
 * years and then quietly stopped — a free-tier policy change in 2031 that
 * nobody is reading email from Cloudflare about.
 */
export function checkSilence(db: DatabaseSync, nowMs: number): SilenceState {
  const raw = getSyncState(db, "last_cloud_write_ms");
  const last = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(last)) {
    return { alarm: false, lastCloudWriteMs: null, ageMs: null };
  }
  const ageMs = nowMs - last;
  return { alarm: ageMs > SILENCE_MS, lastCloudWriteMs: last, ageMs };
}

export interface MaintenanceResult {
  readonly backup: BackupResult | null;
  readonly reconcile: ReconcileReport | null;
  /** Set when the weekly fingerprint check could not complete. */
  readonly reconcileError?: string | undefined;
  readonly silence: SilenceState;
}

export interface MaintenanceOptions extends BackupOptions {
  readonly onMismatch?: (report: ReconcileReport) => void;
}

/**
 * The weekly job: export, then reconcile, then read the silence alarm.
 *
 * The fingerprint result is written next to the backups as
 * `wwb-YYYY-Www.fingerprint.json`, which is both the week marker for this half
 * of the job and a record you can read later of what the two sides held. It is
 * written only after a successful comparison, so an offline week retries at the
 * next launch instead of being silently skipped.
 *
 * Call it after `flush()` and `pull()` have both completed — a machine with a
 * full outbox has a legitimately different fingerprint from the cloud, and
 * `report.local.pending` is how the caller tells the two apart.
 */
export async function weeklyMaintenance(
  db: DatabaseSync,
  client: WorkerClient,
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const backup = weeklyBackup(db, opts);
  const dir = opts.dir ?? backupDir();
  const week = isoWeekOf(nowMs, opts.tz ?? systemTz());
  const marker = join(dir, `wwb-${week}.fingerprint.json`);
  const silence = checkSilence(db, nowMs);

  if (existsSync(marker)) return { backup, reconcile: null, silence };

  try {
    const report = await reconcile(db, client, {
      nowMs: () => nowMs,
      ...(opts.onMismatch ? { onMismatch: opts.onMismatch } : {}),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { backup, reconcile: report, silence };
  } catch (err) {
    // Offline on the day the week turned over is not an emergency, and it is
    // not a reason to crash the boot sequence. No marker is written, so the
    // check runs again at the next launch.
    return {
      backup,
      reconcile: null,
      reconcileError: err instanceof Error ? err.message : String(err),
      silence,
    };
  }
}

function rowOf(row: Row): IntervalRow {
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

function isWritableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function civilMs(localDate: string): number {
  return Date.UTC(
    Number(localDate.slice(0, 4)),
    Number(localDate.slice(5, 7)) - 1,
    Number(localDate.slice(8, 10)),
  );
}

function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
