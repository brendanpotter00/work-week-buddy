/**
 * Task 3.2 — crash recovery.
 *
 * The headline test kills a real process with SIGKILL while it holds an open
 * interval, then reopens the file. Nothing is mocked: the child runs the same
 * `JOURNAL_UPSERT_SQL` the app runs, against a real WAL database with
 * `synchronous = FULL`, and then dies without closing anything.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../../src/store/db";
import { countIntervals, getRow, insertClosed } from "../../src/store/intervals";
import { JOURNAL_UPSERT_SQL, readJournal, writeJournal } from "../../src/store/journal";
import { CRASH_FRESH_MS, recover } from "../../src/store/recovery";
import { makeRow, openTestDb, t, tmpDbPath } from "../fakes/seed-db";

const START = t("2026-08-17T09:00:00Z");
const LAST_SIGNAL = t("2026-08-17T10:00:00Z");
const CFG = { tz: "UTC", appVersion: "0.1.0" } as const;

const SNAP = {
  id: "0198f2c0-crash",
  machineId: "personal",
  startedAtMs: START,
  lastSignalMs: LAST_SIGNAL,
  keyEvents: 1200,
  mouseEvents: 300,
  cameraS: 0,
  jigglerS: 0,
};

/**
 * Open the database, journal an open interval, then SIGKILL this process. No
 * close, no checkpoint — exactly what a power cut or a force-quit does.
 */
function crashAfterJournalling(dbPath: string): void {
  const script = join(dirname(dbPath), "crash-child.mjs");
  writeFileSync(
    script,
    `import { DatabaseSync } from "node:sqlite";
const [dbPath, argsJson] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
db.prepare(${JSON.stringify(JOURNAL_UPSERT_SQL)}).run(...JSON.parse(argsJson));
process.kill(process.pid, "SIGKILL");
`,
  );
  const args = [
    SNAP.id,
    SNAP.machineId,
    SNAP.startedAtMs,
    SNAP.lastSignalMs,
    SNAP.keyEvents,
    SNAP.mouseEvents,
    SNAP.cameraS,
    SNAP.jigglerS,
  ];
  const res = spawnSync(process.execPath, [script, dbPath, JSON.stringify(args)], {
    encoding: "utf8",
  });
  // If this ever exits normally the test is not testing what it claims to.
  expect(res.signal).toBe("SIGKILL");
}

describe("an unclean exit mid-interval", () => {
  it("recovers, closing at last_signal_ms with end_reason crash_recovered", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      openDb(path).close(); // migrations only, then let go of the file
      crashAfterJournalling(path);

      const db = openDb(path);
      expect(readJournal(db)).toMatchObject({ id: SNAP.id, lastSignalMs: LAST_SIGNAL });

      // Relaunched the next morning: the journal is long stale.
      const nowMs = t("2026-08-18T08:00:00Z");
      const out = recover(db, nowMs, CFG);

      expect(out.kind).toBe("closed");
      if (out.kind !== "closed") throw new Error("unreachable");
      expect(out.row.endedAtMs).toBe(LAST_SIGNAL);
      expect(out.row.lastSignalAtMs).toBe(LAST_SIGNAL);
      expect(out.row.endReason).toBe("crash_recovered");
      expect(out.row.durationS).toBe(3600);
      expect(out.row.keyEvents).toBe(1200);
      expect(out.row.localDate).toBe("2026-08-17");

      // And it is on disk, ending where the human actually stopped.
      expect(getRow(db, SNAP.id)).toMatchObject({
        endedAtMs: LAST_SIGNAL,
        endReason: "crash_recovered",
        syncedAtMs: null,
      });
      // The journal is consumed, so a second boot does not re-close it.
      expect(readJournal(db)).toBeNull();
      expect(recover(db, nowMs, CFG)).toEqual({ kind: "none" });
      expect(countIntervals(db)).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("resumes the same interval when the relaunch is quick", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      openDb(path).close();
      crashAfterJournalling(path);

      const db = openDb(path);
      // Back on its feet 40 seconds later: one continuous session.
      const out = recover(db, LAST_SIGNAL + 40_000, CFG);
      expect(out.kind).toBe("resumed");
      if (out.kind !== "resumed") throw new Error("unreachable");
      expect(out.snapshot.id).toBe(SNAP.id);
      expect(out.snapshot.lastSignalMs).toBe(LAST_SIGNAL);
      // Nothing was written, and the journal is still there to be continued.
      expect(countIntervals(db)).toBe(0);
      expect(readJournal(db)).not.toBeNull();
      db.close();
    } finally {
      cleanup();
    }
  });
});

describe("recovery arithmetic", () => {
  it("measures freshness against the last signal, not the app's start time", () => {
    const db = openTestDb();
    writeJournal(db, SNAP);
    // One millisecond inside the window.
    expect(recover(db, LAST_SIGNAL + CRASH_FRESH_MS - 1, CFG).kind).toBe("resumed");

    const db2 = openTestDb();
    writeJournal(db2, SNAP);
    expect(recover(db2, LAST_SIGNAL + CRASH_FRESH_MS, CFG).kind).toBe("closed");
  });

  it("never uses the recovery moment as an end timestamp", () => {
    // However late the app comes back — a minute, a day, three weeks — the row
    // ends at the same instant. If this test starts failing because ended_at_ms
    // moved towards nowMs, that is the bug, not the test.
    for (const nowMs of [
      LAST_SIGNAL + CRASH_FRESH_MS,
      LAST_SIGNAL + 24 * 3_600_000,
      LAST_SIGNAL + 21 * 24 * 3_600_000,
    ]) {
      const db = openTestDb();
      writeJournal(db, SNAP);
      const out = recover(db, nowMs, CFG);
      if (out.kind !== "closed") throw new Error("expected a closed interval");
      expect(out.row.endedAtMs).toBe(LAST_SIGNAL);
      expect(out.row.durationS).toBe(3600);
      expect(out.journalAgeMs).toBe(nowMs - LAST_SIGNAL);
      // nowMs is allowed in exactly one column, and it is a diagnostic.
      expect(out.row.closedLocalMs).toBe(nowMs);
    }
  });

  it("re-inserting a row the crashed process already flushed is a no-op", () => {
    const db = openTestDb();
    // The pre-crash process closed and even uploaded this interval, then died
    // before clearing its journal.
    insertClosed(
      db,
      makeRow({
        id: SNAP.id,
        machineId: "personal",
        start: "2026-08-17T09:00:00Z",
        end: "2026-08-17T10:00:00Z",
        endReason: "idle_timeout",
        syncedAtMs: 999,
        cloudSeq: 5,
      }),
    );
    writeJournal(db, SNAP);

    const out = recover(db, LAST_SIGNAL + 24 * 3_600_000, CFG);
    expect(out.kind).toBe("closed");
    expect(countIntervals(db)).toBe(1);
    // The already-uploaded row is untouched: same reason, still marked synced.
    expect(getRow(db, SNAP.id)).toMatchObject({
      endReason: "idle_timeout",
      syncedAtMs: 999,
      cloudSeq: 5,
    });
    expect(readJournal(db)).toBeNull();
  });

  it("does nothing when there is no journal", () => {
    const db = openTestDb();
    expect(recover(db, Date.now(), CFG)).toEqual({ kind: "none" });
    expect(countIntervals(db)).toBe(0);
  });

  it("collapses a corrupt journal instead of crashing the app at boot", () => {
    const db = openTestDb();
    // last_signal_ms before started_at_ms: not evidence, and not a reason to
    // fail to launch. It lands as a zero-length row that no metric counts.
    writeJournal(db, { ...SNAP, lastSignalMs: START - 60_000 });
    const out = recover(db, LAST_SIGNAL + 24 * 3_600_000, CFG);
    if (out.kind !== "closed") throw new Error("expected a closed interval");
    expect(out.row.durationS).toBe(0);
    expect(out.row.endedAtMs).toBe(START);
    expect(out.row.lastSignalAtMs).toBe(out.row.endedAtMs);
  });

  it("recovers a camera-only interval's accumulated seconds", () => {
    const db = openTestDb();
    // Jiggler-on for the whole hour: toggling it closes the interval and opens
    // a new one, so a stored interval's jiggler_s is either 0 or the whole
    // duration. Recovery must not break that homogeneity.
    writeJournal(db, { ...SNAP, keyEvents: 0, mouseEvents: 0, cameraS: 3600, jigglerS: 3600 });
    const out = recover(db, LAST_SIGNAL + 24 * 3_600_000, CFG);
    if (out.kind !== "closed") throw new Error("expected a closed interval");
    expect(out.row).toMatchObject({ cameraS: 3600, jigglerS: 3600, keyEvents: 0 });
    expect(out.row.jigglerS).toBe(out.row.durationS);
  });
});
