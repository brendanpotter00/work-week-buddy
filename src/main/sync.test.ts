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
import { getSyncState, readMachines, setSyncState } from "../store/sync-state";
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
import { fakeSettings } from "../../test/helpers/runtime";
import { createMachineNaming, type MachineNaming } from "./device-name";
import type { SettingsStore } from "./settings";
import { NOT_CONFIGURED } from "./sync-seam";
import { createSyncService, probeSyncConfig, resolveSyncConfig, type SyncService } from "./sync";

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
  over: {
    configured?: boolean;
    token?: string;
    dir?: string;
    now?: () => number;
    /** A thunk, because a rename mid-session has to reach the NEXT heartbeat. */
    label?: () => string;
  } = {},
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
    machineLabel: over.label ?? (() => "Personal"),
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

// ── device naming, over the real Worker ─────────────────────────────────────

/**
 * A rename made with no network must not fail, and must not be lost.
 *
 * The whole reconciliation story: the rename is durable locally the instant it
 * is made, the heartbeat that would have carried it simply does not land, and
 * the next cycle that reaches the cloud carries the CURRENT name rather than
 * the one this Mac booted with. Nothing retries the rename, because there is
 * nothing to retry — the heartbeat reads the label instead of remembering it.
 */
describe("renaming and the cloud", () => {
  interface Wired extends Made {
    settings: ReturnType<typeof fakeSettings>;
    naming: MachineNaming;
  }

  /**
   * The production wiring, exactly: `settings.json` is the one authority for
   * the name, the sync service READS it per heartbeat, and the naming service
   * writes it. Hand the service a captured string here instead and every test
   * below would pass while the shipped app sent its boot-time name forever.
   */
  function wire(db: DatabaseSync, initial = "MacBook Pro"): Wired {
    const settings = fakeSettings({ machineLabel: initial });
    const made = make(db, { label: () => settings.get("machineLabel") });
    let tick = NOW;
    const naming = createMachineNaming({
      db,
      machineId: MACHINE_PERSONAL,
      settings: settings as unknown as SettingsStore,
      appVersion: "0.1.0-test",
      osVersion: "26.5.1",
      pushHeartbeat: async () => {
        await made.service.heartbeatNow();
      },
      now: () => (tick += 1000),
    });
    return { ...made, settings, naming };
  }

  function cloudLabel(cloud: FakeCloud): string | null {
    const rows = cloud.d1.query<{ label: string | null }>(
      "SELECT label FROM machine WHERE machine_id = ?",
      MACHINE_PERSONAL,
    );
    return rows[0]?.label ?? null;
  }

  it("a rename made OFFLINE reaches the cloud on the next successful sync", async () => {
    const db = openTestDb();
    const { service, cloud, naming, settings } = wire(db);
    await naming.init();

    // Establish the old name in the cloud, then pull the plug.
    await service.runCycle("launch");
    expect(cloudLabel(cloud)).toBe("MacBook Pro");
    cloud.offline = true;

    const res = await naming.rename("The loft mini");
    await res.pushed;

    // The rename SUCCEEDED. It is durable in settings and in the local row, and
    // the dashboard already shows it — the cloud simply has not heard yet.
    expect(res.label).toBe("The loft mini");
    expect(settings.get("machineLabel")).toBe("The loft mini");
    expect(readMachines(db)[0]?.label).toBe("The loft mini");
    expect(cloudLabel(cloud)).toBe("MacBook Pro");

    // The network comes back. Nothing re-triggers the rename and no queue holds
    // it — the ordinary wake cycle carries it, because the heartbeat reads the
    // label rather than remembering it.
    cloud.offline = false;
    await service.runCycle("wake");

    expect(cloudLabel(cloud)).toBe("The loft mini");
  });

  it("pushes immediately when the network is there, rather than waiting for a launch", async () => {
    const db = openTestDb();
    const { cloud, naming } = wire(db);
    await naming.init();

    const res = await naming.rename("The loft mini");
    await res.pushed;

    expect(cloudLabel(cloud)).toBe("The loft mini");
    // Liveness, not an upload: the heartbeat moved no interval.
    expect(cloud.count()).toBe(0);
  });

  it("mirrors the heartbeat locally, so the breakdown agrees with the cloud", async () => {
    const db = openTestDb();
    const { service } = make(db, { label: () => "The loft mini" });

    await service.runCycle("launch");

    expect(readMachines(db)).toEqual([
      {
        machineId: MACHINE_PERSONAL,
        label: "The loft mini",
        osVersion: "26.5.1",
        appVersion: "0.1.0-test",
        lastSeenMs: NOW,
      },
    ]);
  });

  it("writes no machine row when there is no cloud to beat to", async () => {
    const db = openTestDb();
    const { service } = make(db, { configured: false });

    await service.runCycle("launch");

    // The heartbeat is the cloud mirror and it never ran. Boot's own
    // `naming.init()` writes the row on an unconfigured install; asserted here
    // so the two writers stay distinct rather than quietly covering for each
    // other.
    expect(readMachines(db)).toEqual([]);
  });
});

/**
 * "Test connection", against the real Worker routes.
 *
 * The two requests it makes are the two diagnoses it can give, and they need
 * different fixes: a URL that is not a Worker, and a token the Worker rejects.
 * The second one is the likely mistake — bring-up mints one token per Mac and
 * swapping them fails exactly like this — and it is the one a URL-only check
 * can never produce.
 */
describe("probeSyncConfig", () => {
  const probe = (url: string, token: string | null, cloud: FakeCloud) =>
    probeSyncConfig(url, token, { fetchImpl: cloud.fetch, now: () => NOW });

  it("says configured-and-working only when BOTH requests succeed", async () => {
    const cloud = new FakeCloud();
    const r = await probe(BASE_URL, TOKEN_PERSONAL, cloud);
    expect(r).toMatchObject({ ok: true, reachable: true, authorized: true, error: null });
    // /health first, then an authenticated read. /fingerprint would also have
    // proved the token and hashes every row id to do it; a button somebody
    // presses while typing does not get to be that expensive.
    expect(cloud.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /health",
      "GET /machines",
    ]);
  });

  it("separates a rejected token from an unreachable Worker", async () => {
    const cloud = new FakeCloud();
    const r = await probe(BASE_URL, "not-the-right-token", cloud);
    expect(r.reachable).toBe(true);
    expect(r.authorized).toBe(false);
    expect(r.status).toBe(401);
    // The sentence has to name the mistake that is actually likely.
    expect(r.error).toMatch(/each Mac gets its own/i);
  });

  it("blames the network — and names the proxy — when nothing answers", async () => {
    const cloud = new FakeCloud();
    cloud.offline = true;
    const r = await probe(BASE_URL, TOKEN_PERSONAL, cloud);
    expect(r).toMatchObject({ ok: false, reachable: false, authorized: false });
    // `/health` is unauthenticated precisely so bring-up can prove the work
    // Mac's proxy allows workers.dev. Say so where it will be read.
    expect(r.error).toMatch(/workers\.dev/);
  });

  it("says which half is missing rather than calling anything", async () => {
    const cloud = new FakeCloud();
    expect(await probe("", TOKEN_PERSONAL, cloud)).toMatchObject({
      ok: false,
      error: "enter the Worker URL first",
    });
    expect(await probe(BASE_URL, null, cloud)).toMatchObject({
      ok: false,
      error: "enter this Mac's token first",
    });
    expect(await probe(BASE_URL, "   ", cloud)).toMatchObject({ ok: false });
    // Not one request was made for a configuration that cannot be used.
    expect(cloud.calls).toEqual([]);
  });

  it("carries the same URL verdict as resolveSyncConfig, and never throws", async () => {
    const cloud = new FakeCloud();
    const r = await probe("wwb-sync.example.workers.dev", TOKEN_PERSONAL, cloud);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a URL/);
    expect(cloud.calls).toEqual([]);
  });

  it("trims a token pasted with a trailing newline instead of failing on it", async () => {
    const cloud = new FakeCloud();
    const r = await probe(`  ${BASE_URL}  `, `\n${TOKEN_PERSONAL}\n`, cloud);
    expect(r.ok).toBe(true);
  });
});
