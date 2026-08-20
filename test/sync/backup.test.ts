/**
 * Backup layers 2 and 4.
 *
 * The load-bearing test is the round trip: an export nobody has restored is a
 * hypothesis, and the NDJSON is the artifact that makes leaving Cloudflare
 * cheap. It is restored here into a real, empty database through the same
 * parser a pull uses.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  backupDir,
  checkSilence,
  ICLOUD_RELATIVE,
  isoWeekOf,
  KEEP_BACKUPS,
  SILENCE_MS,
  weeklyBackup,
  weeklyMaintenance,
} from "../../src/sync/backup";
import { restoreNdjsonGz, readNdjsonGz } from "../../src/sync/restore";
import { createWorkerClient } from "../../src/sync/client";
import { createFlusher } from "../../src/sync/flush";
import { openDb } from "../../src/store/db";
import { countIntervals, insertClosed, pendingRows } from "../../src/store/intervals";
import { setSyncState } from "../../src/store/sync-state";
import { makeRow, openTestDb, t } from "../fakes/seed-db";
import { BASE_URL, FakeCloud, TOKEN_PERSONAL } from "./fake-cloud";

const NOW = t("2026-08-19T12:00:00Z"); // a Wednesday
const dirs: string[] = [];

function tmp(prefix = "wwb-backup-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seeded(count: number) {
  const db = openTestDb();
  for (let i = 0; i < count; i++) {
    insertClosed(
      db,
      makeRow({
        id: `id-${String(i).padStart(3, "0")}`,
        machineId: "personal",
        start: `2026-08-17T09:${String(i).padStart(2, "0")}:00Z`,
        end: `2026-08-17T09:${String(i).padStart(2, "0")}:30Z`,
        keyEvents: i,
        cameraS: i % 3,
      }),
    );
  }
  return db;
}

describe("the ISO week label", () => {
  // ISO weeks belong to the year containing their Thursday. These five dates
  // are where a naive `dayOfYear / 7` gets a different answer.
  it.each([
    ["2026-08-19T12:00:00Z", "2026-W34"],
    ["2026-01-01T12:00:00Z", "2026-W01"], // a Thursday: week 1 of its own year
    ["2025-12-29T12:00:00Z", "2026-W01"], // Monday, already next ISO year
    ["2025-12-28T12:00:00Z", "2025-W52"], // the Sunday before it
    ["2027-01-03T12:00:00Z", "2026-W53"], // 2026 is a 53-week year
    ["2021-01-01T12:00:00Z", "2020-W53"],
  ])("%s is %s", (iso, week) => {
    expect(isoWeekOf(t(iso), "UTC")).toBe(week);
  });

  it("labels the week in the machine's own zone", () => {
    // 2026-08-17T02:00Z is still Sunday the 16th in Chicago, hence week 33.
    expect(isoWeekOf(t("2026-08-17T02:00:00Z"), "UTC")).toBe("2026-W34");
    expect(isoWeekOf(t("2026-08-17T02:00:00Z"), "America/Chicago")).toBe("2026-W33");
  });
});

describe("where backups go", () => {
  it("prefers iCloud Drive when it is there and writable", () => {
    const home = tmp("wwb-home-");
    mkdirSync(join(home, ICLOUD_RELATIVE), { recursive: true });

    expect(backupDir(home)).toBe(join(home, ICLOUD_RELATIVE, "WorkWeekBuddy"));
  });

  it("falls back to ~/Documents when iCloud Drive is absent", () => {
    const home = tmp("wwb-home-");

    expect(backupDir(home)).toBe(join(home, "Documents", "WorkWeekBuddy", "backups"));
  });

  it("falls back when the iCloud path exists but is not a directory", () => {
    const home = tmp("wwb-home-");
    mkdirSync(join(home, "Library", "Mobile Documents"), { recursive: true });
    writeFileSync(join(home, ICLOUD_RELATIVE), "not a directory");

    expect(backupDir(home)).toBe(join(home, "Documents", "WorkWeekBuddy", "backups"));
  });
});

describe("the weekly export", () => {
  it("writes both files for the current ISO week", () => {
    const dir = tmp();
    const db = seeded(5);

    const res = weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" });

    expect(res).toMatchObject({ week: "2026-W34", rows: 5, pruned: [] });
    expect(readdirSync(dir).sort()).toEqual([
      "wwb-2026-W34.ndjson.gz",
      "wwb-2026-W34.sqlite",
    ]);
    expect(res?.written).toEqual([
      join(dir, "wwb-2026-W34.sqlite"),
      join(dir, "wwb-2026-W34.ndjson.gz"),
    ]);
  });

  it("does not write twice in the same ISO week", () => {
    const dir = tmp();
    const db = seeded(2);

    expect(weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" })).not.toBeNull();
    expect(weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" })).toBeNull();
    // …and writes again once the week turns over.
    const next = weeklyBackup(db, { nowMs: NOW + 7 * 86_400_000, dir, tz: "UTC" });
    expect(next?.week).toBe("2026-W35");
  });

  it("re-runs the week when a file was lost — the filesystem is the marker", () => {
    const dir = tmp();
    const db = seeded(2);
    weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" });

    rmSync(join(dir, "wwb-2026-W34.ndjson.gz"));

    // A database row saying "done" would have lied here.
    expect(weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" })).not.toBeNull();
    expect(existsSync(join(dir, "wwb-2026-W34.ndjson.gz"))).toBe(true);
  });

  it("overwrites a truncated .sqlite left by a crash mid-write", () => {
    const dir = tmp();
    const db = seeded(2);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wwb-2026-W34.sqlite.tmp"), "garbage from a kill -9");

    expect(() => weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" })).not.toThrow();
    expect(existsSync(join(dir, "wwb-2026-W34.sqlite"))).toBe(true);
  });

  it("keeps a year of pairs and prunes what falls off the end", () => {
    expect(KEEP_BACKUPS).toBe(52);
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    for (const week of ["2026-W30", "2026-W31", "2026-W32"]) {
      writeFileSync(join(dir, `wwb-${week}.sqlite`), "old");
      writeFileSync(join(dir, `wwb-${week}.ndjson.gz`), "old");
    }
    // Something else living in the folder is never touched.
    writeFileSync(join(dir, "notes.txt"), "hello");

    const res = weeklyBackup(seeded(1), { nowMs: NOW, dir, tz: "UTC", keep: 3 });

    expect(res?.pruned).toEqual([
      join(dir, "wwb-2026-W30.ndjson.gz"),
      join(dir, "wwb-2026-W30.sqlite"),
    ]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sqlite")).sort()).toEqual([
      "wwb-2026-W31.sqlite",
      "wwb-2026-W32.sqlite",
      "wwb-2026-W34.sqlite",
    ]);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("the .sqlite copy is a real database holding every row", () => {
    const dir = tmp();
    const db = seeded(4);

    weeklyBackup(db, { nowMs: NOW, dir, tz: "UTC" });

    const copy = openDb(join(dir, "wwb-2026-W34.sqlite"));
    expect(countIntervals(copy)).toBe(4);
    copy.close();
  });
});

describe("restoring the NDJSON", () => {
  it("round-trips into an empty database with identical rows", () => {
    const dir = tmp();
    const source = seeded(6);
    source.exec("UPDATE work_interval SET synced_at_ms = 111, cloud_seq = 9 WHERE id = 'id-000'");
    weeklyBackup(source, { nowMs: NOW, dir, tz: "UTC" });
    const path = join(dir, "wwb-2026-W34.ndjson.gz");

    const restored = openTestDb();
    const inserted = restoreNdjsonGz(restored, path);

    expect(inserted).toBe(6);
    const before = source
      .prepare("SELECT id, started_at_ms, ended_at_ms, duration_s, key_events, camera_s FROM work_interval ORDER BY id")
      .all();
    const after = restored
      .prepare("SELECT id, started_at_ms, ended_at_ms, duration_s, key_events, camera_s FROM work_interval ORDER BY id")
      .all();
    expect(after).toEqual(before);
  });

  it("restores rows as PENDING, so a flush rebuilds a lost cloud", async () => {
    const dir = tmp();
    weeklyBackup(seeded(3), { nowMs: NOW, dir, tz: "UTC" });

    const restored = openTestDb();
    restoreNdjsonGz(restored, join(dir, "wwb-2026-W34.ndjson.gz"));

    expect(pendingRows(restored)).toHaveLength(3);

    const cloud = new FakeCloud();
    await createFlusher({
      db: restored,
      client: createWorkerClient({
        baseUrl: BASE_URL,
        token: TOKEN_PERSONAL,
        fetchImpl: cloud.fetch,
      }),
    }).flush();

    expect(cloud.count()).toBe(3);
  });

  it("restoring twice inserts nothing the second time", () => {
    const dir = tmp();
    weeklyBackup(seeded(3), { nowMs: NOW, dir, tz: "UTC" });
    const path = join(dir, "wwb-2026-W34.ndjson.gz");
    const db = openTestDb();

    expect(restoreNdjsonGz(db, path)).toBe(3);
    expect(restoreNdjsonGz(db, path)).toBe(0);
    expect(countIntervals(db)).toBe(3);
  });

  it("is sorted by id, so two exports of the same data are the same bytes", () => {
    const dir = tmp();
    weeklyBackup(seeded(5), { nowMs: NOW, dir, tz: "UTC" });

    const parsed = readNdjsonGz(join(dir, "wwb-2026-W34.ndjson.gz"));

    expect(parsed.map((r) => r.id)).toEqual([...parsed.map((r) => r.id)].sort());
  });

  it("refuses a corrupted line rather than writing quiet zeroes", () => {
    const db = openTestDb();
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "broken.ndjson.gz");
    // A valid gzip of invalid content.
    writeFileSync(path, gzipSync(Buffer.from('{"id":"a"}\n', "utf8")));

    expect(() => restoreNdjsonGz(db, path)).toThrow(/ndjson line 1/);
    expect(countIntervals(db)).toBe(0);
  });
});

describe("the 72-hour silence alarm", () => {
  it("does not alarm at 72 hours minus a minute, and does at 72 plus a minute", () => {
    const db = openTestDb();
    setSyncState(db, "last_cloud_write_ms", String(NOW));

    expect(checkSilence(db, NOW + SILENCE_MS - 60_000).alarm).toBe(false);
    expect(checkSilence(db, NOW + SILENCE_MS + 60_000).alarm).toBe(true);
  });

  it("reports the age so the tray can say how long it has been", () => {
    const db = openTestDb();
    setSyncState(db, "last_cloud_write_ms", String(NOW));

    expect(checkSilence(db, NOW + 3_600_000)).toEqual({
      alarm: false,
      lastCloudWriteMs: NOW,
      ageMs: 3_600_000,
    });
  });

  it("clears the moment a cloud write succeeds", async () => {
    const cloud = new FakeCloud();
    const db = seeded(1);
    setSyncState(db, "last_cloud_write_ms", String(NOW - 4 * 24 * 3_600_000));
    expect(checkSilence(db, NOW).alarm).toBe(true);

    await createFlusher({
      db,
      client: createWorkerClient({
        baseUrl: BASE_URL,
        token: TOKEN_PERSONAL,
        fetchImpl: cloud.fetch,
      }),
      nowMs: () => NOW,
    }).flush();

    expect(checkSilence(db, NOW).alarm).toBe(false);
  });

  it("stays quiet on a mirror that has never written to the cloud", () => {
    expect(checkSilence(openTestDb(), NOW)).toEqual({
      alarm: false,
      lastCloudWriteMs: null,
      ageMs: null,
    });
  });

  it("treats a corrupt timestamp as never, not as 1970", () => {
    const db = openTestDb();
    setSyncState(db, "last_cloud_write_ms", "yesterday");
    expect(checkSilence(db, NOW).alarm).toBe(false);
  });
});

describe("the weekly job", () => {
  function client(cloud: FakeCloud) {
    return createWorkerClient({
      baseUrl: BASE_URL,
      token: TOKEN_PERSONAL,
      fetchImpl: cloud.fetch,
    });
  }

  it("exports, reconciles, and leaves the comparison on disk to read later", async () => {
    const dir = tmp();
    const cloud = new FakeCloud();
    const db = seeded(3);
    await createFlusher({ db, client: client(cloud) }).flush();

    const res = await weeklyMaintenance(db, client(cloud), { nowMs: NOW, dir, tz: "UTC" });

    expect(res.backup?.week).toBe("2026-W34");
    expect(res.reconcile?.status).toBe("match");
    expect(res.silence.alarm).toBe(false);
    expect(existsSync(join(dir, "wwb-2026-W34.fingerprint.json"))).toBe(true);
  });

  it("runs once a week, not once a launch", async () => {
    const dir = tmp();
    const cloud = new FakeCloud();
    const db = seeded(1);

    await weeklyMaintenance(db, client(cloud), { nowMs: NOW, dir, tz: "UTC" });
    const second = await weeklyMaintenance(db, client(cloud), { nowMs: NOW, dir, tz: "UTC" });

    expect(second.backup).toBeNull();
    expect(second.reconcile).toBeNull();
  });

  it("retries next launch when the week turned over while offline", async () => {
    const dir = tmp();
    const cloud = new FakeCloud();
    const db = seeded(1);
    cloud.offline = true;

    const offline = await weeklyMaintenance(db, client(cloud), { nowMs: NOW, dir, tz: "UTC" });

    // The export still happened — it needs no network, which is the point of
    // having it — but no marker was written for the comparison.
    expect(offline.backup).not.toBeNull();
    expect(offline.reconcile).toBeNull();
    expect(offline.reconcileError).toMatch(/fetch failed/);
    expect(existsSync(join(dir, "wwb-2026-W34.fingerprint.json"))).toBe(false);

    cloud.offline = false;
    const retried = await weeklyMaintenance(db, client(cloud), { nowMs: NOW, dir, tz: "UTC" });

    // Both sides hold nothing yet — the one local row has never been uploaded.
    // A full outbox is not a mismatch, and `pending` is how a caller tells the
    // "not yet" case from the "lost it" case.
    expect(retried.reconcile?.status).toBe("match");
    expect(retried.reconcile?.local.pending).toBe(1);
    expect(retried.reconcile?.local.count).toBe(0);
    expect(existsSync(join(dir, "wwb-2026-W34.fingerprint.json"))).toBe(true);
  });

  it("hands a mismatch to the caller for the tray badge", async () => {
    const dir = tmp();
    const cloud = new FakeCloud();
    const db = seeded(2);
    await createFlusher({ db, client: client(cloud) }).flush();
    cloud.wipe();

    const seen: string[] = [];
    const res = await weeklyMaintenance(db, client(cloud), {
      nowMs: NOW,
      dir,
      tz: "UTC",
      onMismatch: (r) => seen.push(r.status),
    });

    expect(res.reconcile?.status).toBe("mismatch");
    expect(res.reconcile?.missingFromCloud).toBe(2);
    expect(seen).toEqual(["mismatch"]);
  });
});
