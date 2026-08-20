/**
 * The wire between `src/sync/` and the app, exercised against the real Worker.
 *
 * The cloud here is `test/sync/fake-cloud.ts` — the deployed `worker/src/` over
 * a `node:sqlite` D1 double — so "the row landed" is a fact about the real
 * routes, the real presence read-back and the real machine-id stamping, not
 * about a mock that was written to agree.
 *
 * Half of this file is about the UNCONFIGURED path, which is the state the app
 * ships in: no Worker URL, no token, and nothing about that is an error.
 */
import { describe, it, expect, afterEach, onTestFinished } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { insertClosed, pendingCount, pendingRows } from "../store/intervals";
import { getSyncState, setSyncState } from "../store/sync-state";
import { SILENCE_MS, isoWeekOf } from "../sync/backup";
import { makeRow, openTestDb, t } from "../../test/fakes/seed-db";
import {
  BASE_URL,
  FakeCloud,
  MACHINE_PERSONAL,
  MACHINE_WORK,
  TOKEN_PERSONAL,
  TOKEN_WORK,
} from "../../test/sync/fake-cloud";
import { NOT_CONFIGURED } from "./sync-seam";
import { createSyncService, resolveSyncConfig, type SyncService } from "./sync";

const NOW = t("2026-08-19T12:00:00Z"); // a Wednesday
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-mainsync-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seeded(count: number, from = "2026-08-19T09:00:00Z"): DatabaseSync {
  const db = openTestDb();
  const base = t(from);
  for (let i = 0; i < count; i++) {
    insertClosed(
      db,
      makeRow({
        id: `local-${String(i).padStart(3, "0")}`,
        machineId: "personal",
        start: new Date(base + i * 600_000).toISOString(),
        end: new Date(base + i * 600_000 + 300_000).toISOString(),
      }),
    );
  }
  return db;
}

interface Made {
  service: SyncService;
  cloud: FakeCloud;
  dir: string;
  changes: string[];
}

/**
 * Every service this file makes is STOPPED before the test ends.
 *
 * A configured service owns a backoff timer and, past its first `await`, an
 * open read over the database. Registering the teardown at construction is what
 * makes "no flusher outlives its test" structural rather than a line at the
 * bottom of a test body that an earlier failed assertion skips.
 */
function make(
  db: DatabaseSync,
  over: { configured?: boolean; token?: string; dir?: string; now?: () => number } = {},
): Made {
  const cloud = new FakeCloud();
  const dir = over.dir ?? tmp();
  const changes: string[] = [];
  const resolved = resolveSyncConfig(
    over.configured === false ? "" : BASE_URL,
    over.configured === false ? null : (over.token ?? TOKEN_PERSONAL),
  );
  const service = createSyncService({
    db,
    config: resolved.config,
    configError: resolved.error,
    machineId: MACHINE_PERSONAL,
    machineLabel: () => "Personal",
    appVersion: "0.1.0-test",
    osVersion: "26.5.1",
    tz: "UTC",
    backupDir: dir,
    now: over.now ?? (() => NOW),
    fetchImpl: cloud.fetch,
    onChange: (kind) => changes.push(kind),
  });
  onTestFinished(async () => {
    await service.stop();
  });
  return { service, cloud, dir, changes };
}

// ── the state the app ships in ──────────────────────────────────────────────

describe("not configured", () => {
  it("answers honestly and touches no network at all", async () => {
    const db = seeded(3);
    const { service, cloud } = make(db, { configured: false });

    expect(service.configured).toBe(false);
    const res = await service.flush();

    expect(res.ok).toBe(false);
    expect(res.error).toBe(NOT_CONFIGURED);
    expect(res.attempted).toBe(0);
    // The rows are not lost, they are simply still here. That number is the
    // one true thing there is to say in this state.
    expect(res.pendingAfter).toBe(3);
    expect(cloud.calls).toEqual([]);
  });

  it("reports a state, not a failure: every timestamp null, nothing degraded", async () => {
    const { service } = make(seeded(2), { configured: false });
    await service.runCycle("launch");

    const snap = service.snapshot();
    expect(snap.sync.configured).toBe(false);
    expect(snap.sync.lastFlushOkMs).toBeNull();
    expect(snap.sync.lastPullMs).toBeNull();
    expect(snap.sync.lastCloudWriteMs).toBeNull();
    expect(snap.sync.watermark).toBe(0);
    // Never silent, because there is nothing to be silent about. A fresh
    // install must not trip the 72-hour alarm on day four.
    expect(snap.sync.silentForMs).toBeNull();
    expect(service.health()).toEqual({
      configured: false,
      silentForMs: null,
      fingerprintMatched: null,
    });
  });

  it("still writes the weekly local export — backup layer 2 needs no cloud", async () => {
    const { service, dir } = make(seeded(4), { configured: false });
    await service.runCycle("launch");

    const week = isoWeekOf(NOW, "UTC");
    expect(existsSync(join(dir, `wwb-${week}.sqlite`))).toBe(true);
    expect(existsSync(join(dir, `wwb-${week}.ndjson.gz`))).toBe(true);
    // No cloud, so no fingerprint marker: there is nothing to compare against.
    expect(existsSync(join(dir, `wwb-${week}.fingerprint.json`))).toBe(false);
    expect(service.snapshot().backup.lastPath).toContain(`wwb-${week}.sqlite`);
  });

  it("says WHY when a URL is set but unusable, instead of silently doing nothing", async () => {
    const db = seeded(1);
    const resolved = resolveSyncConfig("wwb-sync.example.workers.dev", "tok");
    expect(resolved.config).toBeNull();
    expect(resolved.error).toMatch(/not a URL/);

    const service = createSyncService({
      db,
      config: resolved.config,
      configError: resolved.error,
      machineId: MACHINE_PERSONAL,
      appVersion: "0.1.0-test",
      backupDir: tmp(),
      now: () => NOW,
    });
    onTestFinished(async () => {
      await service.stop();
    });
    const res = await service.flush();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a URL/);
    expect(service.snapshot().sync.configured).toBe(false);
  });

  it("accepts a token pasted later, without a relaunch", async () => {
    const db = seeded(2);
    const { service, cloud } = make(db, { configured: false });
    expect((await service.flush()).ok).toBe(false);

    const resolved = resolveSyncConfig(BASE_URL, TOKEN_PERSONAL);
    // The service was built with a real `fetchImpl`, so reconfiguring reaches
    // the same fake cloud — this is the "paste the token into onboarding and
    // it just starts working" path.
    await service.reconfigure(resolved.config, resolved.error);

    const res = await service.flush();
    expect(res.ok).toBe(true);
    expect(res.confirmed).toBe(2);
    expect(cloud.count()).toBe(2);
  });
});

// ── configured, against the real Worker ─────────────────────────────────────

describe("configured", () => {
  it("flushes the outbox and marks only what the server reported present", async () => {
    const db = seeded(6);
    const { service, cloud } = make(db);

    const res = await service.flush();

    expect(res.ok).toBe(true);
    expect(res.attempted).toBe(6);
    expect(res.confirmed).toBe(6);
    expect(res.pendingAfter).toBe(0);
    expect(cloud.count()).toBe(6);
    expect(pendingRows(db)).toEqual([]);

    const snap = service.snapshot();
    expect(snap.sync.configured).toBe(true);
    expect(snap.sync.lastFlushOkMs).toBe(NOW);
    expect(snap.sync.lastFlushError).toBeNull();
    expect(snap.sync.pendingRows).toBe(0);
  });

  it("pulls after a successful flush, so the other Mac's rows arrive", async () => {
    const db = seeded(1);
    const { service, cloud, changes } = make(db);

    // A row written by the WORK machine, straight into the cloud.
    await cloud.fetch(`${BASE_URL}/intervals`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_WORK}`, "content-type": "application/json" },
      body: JSON.stringify({
        rows: [
          {
            id: "from-work-mac",
            machine_id: MACHINE_WORK,
            started_at_ms: t("2026-08-18T09:00:00Z"),
            ended_at_ms: t("2026-08-18T10:00:00Z"),
            duration_s: 3600,
            end_reason: "idle_timeout",
            tz: "UTC",
            local_date: "2026-08-18",
            key_events: 10,
            mouse_events: 5,
            camera_s: 0,
            jiggler_s: 0,
            app_version: "0.1.0-test",
            schema_v: 1,
            closed_local_ms: t("2026-08-18T10:15:00Z"),
            server_ms: null,
          },
        ],
      }),
    });

    await service.flush();

    // Ingested locally, and the watermark moved. AGENTS.md #9: the range read
    // starts 200 behind the stored watermark, never strictly above it.
    const row = db.prepare("SELECT id, machine_id FROM work_interval WHERE id = ?").get("from-work-mac");
    expect(row).toBeDefined();
    expect(service.snapshot().sync.watermark).toBeGreaterThan(0);
    expect(service.snapshot().sync.lastPullMs).toBe(NOW);
    // The dashboard has to hear about rows it did not write.
    expect(changes).toContain("rows-pulled");
    expect(cloud.pullSince().length).toBeGreaterThan(0);
  });

  it("a pulled row is not re-uploaded — it is in the cloud by definition", async () => {
    const db = seeded(1);
    const { service } = make(db);
    await service.flush();
    const before = pendingCount(db);
    await service.flush();
    expect(before).toBe(0);
    expect(pendingCount(db)).toBe(0);
  });

  it("offline: nothing is marked, nothing is lost, and the error is reported", async () => {
    const db = seeded(3);
    const { service, cloud } = make(db);
    cloud.offline = true;

    const res = await service.flush();

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fetch failed/);
    expect(res.pendingAfter).toBe(3);
    expect(pendingCount(db)).toBe(3);
    expect(service.snapshot().sync.lastFlushOkMs).toBeNull();
    expect(service.snapshot().sync.lastFlushError).toMatch(/fetch failed/);
    // A flush that failed does not go on to fail a pull as well: one outage,
    // one error string.
    expect(service.snapshot().sync.lastPullError).toBeNull();
  });

  it("two flushes racing are one drain and one pull", async () => {
    const db = seeded(5);
    const { service, cloud } = make(db);

    const [a, b] = await Promise.all([service.flush(), service.flush()]);

    expect(a).toBe(b);
    expect(cloud.postCount()).toBe(1);
    expect(cloud.pullSince()).toHaveLength(1);
  });

  it("a heartbeat keeps the 72-hour alarm meaningful during an empty fortnight", async () => {
    const db = openTestDb(); // nothing pending at all
    const { service } = make(db);

    await service.runCycle("launch");

    // The alarm asks "is anything of ours reaching the cloud", and an empty
    // outbox answers with silence — which would otherwise trip an alarm that
    // means nothing. The heartbeat is the honest answer.
    expect(getSyncState(db, "last_cloud_write_ms")).toBe(String(NOW));
    expect(service.snapshot().sync.lastCloudWriteMs).toBe(NOW);
    expect(service.snapshot().sync.silentForMs).toBe(0);
  });

  it("runs the weekly maintenance pass: export, fingerprint, silence", async () => {
    const db = seeded(4);
    const { service, dir } = make(db);

    await service.runCycle("launch");

    const week = isoWeekOf(NOW, "UTC");
    expect(existsSync(join(dir, `wwb-${week}.sqlite`))).toBe(true);
    expect(existsSync(join(dir, `wwb-${week}.ndjson.gz`))).toBe(true);
    // The marker is both the week gate and a record of what the two sides held.
    expect(existsSync(join(dir, `wwb-${week}.fingerprint.json`))).toBe(true);

    const snap = service.snapshot();
    expect(snap.fingerprint.matched).toBe(true);
    expect(snap.fingerprint.localCount).toBe(4);
    expect(snap.fingerprint.cloudCount).toBe(4);
    expect(snap.fingerprint.localSha).toBe(snap.fingerprint.cloudSha);
    expect(snap.backup.ageDays).toBe(0);
    expect(snap.backup.destination).toBe("documents");
    expect(service.health().fingerprintMatched).toBe(true);
  });

  it("does not repeat the weekly pass on the second launch of the same week", async () => {
    const db = seeded(2);
    const { service, dir } = make(db);
    await service.runCycle("launch");
    const after = readdirSync(dir).sort();
    await service.runCycle("wake");
    expect(readdirSync(dir).sort()).toEqual(after);
    // …and it still knows when the backup was, rather than reporting "never".
    expect(service.snapshot().backup.lastAtMs).not.toBeNull();
  });

  it("catches SILENT loss: the cloud loses rows and the fingerprint says so", async () => {
    const db = seeded(5);
    const { service, cloud } = make(db);
    await service.flush();
    expect(cloud.count()).toBe(5);

    // Total vendor loss, simulated. Nothing local changes; nothing throws;
    // without layer 3 nobody would ever learn.
    cloud.wipe();
    await service.runCycle("launch");

    expect(service.health().fingerprintMatched).toBe(false);
    const snap = service.snapshot();
    expect(snap.fingerprint.matched).toBe(false);
    expect(snap.fingerprint.localCount).toBe(5);
    expect(snap.fingerprint.cloudCount).toBe(0);
  });

  it("survives a cloud that is offline during the weekly pass, and retries next launch", async () => {
    const db = seeded(2);
    const { service, cloud, dir } = make(db);
    cloud.offline = true;

    // Offline on the day the week turned over is not an emergency, and it is
    // certainly not a reason to lose the boot sequence.
    await expect(service.runCycle("launch")).resolves.toBeUndefined();

    const week = isoWeekOf(NOW, "UTC");
    // The local export still happened — it needs no network.
    expect(existsSync(join(dir, `wwb-${week}.sqlite`))).toBe(true);
    // The marker did NOT, so the check runs again at the next launch instead of
    // being silently skipped for the week.
    expect(existsSync(join(dir, `wwb-${week}.fingerprint.json`))).toBe(false);
    expect(service.health().fingerprintMatched).toBeNull();
  });
});

// ── backup layer 4 ──────────────────────────────────────────────────────────

describe("the 72-hour silence alarm", () => {
  it("fires on the watchdog tick once nothing of ours has reached the cloud", () => {
    const db = seeded(1);
    const { service, changes } = make(db);
    setSyncState(db, "last_cloud_write_ms", String(NOW - SILENCE_MS - 60_000));

    service.pollSilence(NOW);

    expect(service.health().silentForMs).toBeGreaterThan(SILENCE_MS);
    // One integer read on a tick that already exists — and a change event, so
    // the tray icon moves without a sixth timer anywhere in the app.
    expect(changes).toContain("sync");
  });

  it("does not fire one minute early, and does not fire on a fresh install", () => {
    const db = seeded(1);
    const { service, changes } = make(db);

    // Never written to the cloud: there is nothing to be silent about.
    service.pollSilence(NOW);
    expect(service.health().silentForMs).toBeNull();
    expect(changes).toEqual([]);

    setSyncState(db, "last_cloud_write_ms", String(NOW - SILENCE_MS + 60_000));
    service.pollSilence(NOW);
    expect(service.health().silentForMs).toBeLessThan(SILENCE_MS);
    expect(changes).toEqual([]);
  });
});

describe("resolveSyncConfig", () => {
  it("treats a missing half as the ordinary unconfigured state, with no error", () => {
    expect(resolveSyncConfig("", null)).toEqual({ config: null, error: null });
    expect(resolveSyncConfig(BASE_URL, null)).toEqual({ config: null, error: null });
    expect(resolveSyncConfig("", "tok")).toEqual({ config: null, error: null });
    expect(resolveSyncConfig("   ", "   ")).toEqual({ config: null, error: null });
  });

  it("rejects a URL that is not http(s), so a typo cannot become a fetch", () => {
    expect(resolveSyncConfig("javascript:alert(1)", "tok").error).toMatch(/http/);
    expect(resolveSyncConfig("file:///etc/passwd", "tok").config).toBeNull();
  });

  it("trims both halves — a pasted URL and token carry whitespace", () => {
    expect(resolveSyncConfig(`  ${BASE_URL}  `, "  tok\n")).toEqual({
      config: { baseUrl: BASE_URL, token: "tok" },
      error: null,
    });
  });
});
