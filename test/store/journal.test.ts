import { describe, it, expect } from "vitest";
import { NO_SIGNAL, type OpenInterval } from "../../src/core/types";
import {
  openFromSnapshot,
  readJournal,
  snapshotFromOpen,
  writeJournal,
} from "../../src/store/journal";
import { openTestDb, t } from "../fakes/seed-db";

const START = t("2026-08-17T09:00:00Z");
const LAST_SIGNAL = t("2026-08-17T10:00:00Z");

function open(overrides: Partial<OpenInterval> = {}): OpenInterval {
  return {
    id: "open-1",
    startedAtMs: START,
    startSource: "input",
    lastRealSignalMs: LAST_SIGNAL,
    lastInputMs: LAST_SIGNAL,
    keyEvents: 400,
    mouseEvents: 90,
    cameraMs: 0,
    micMs: 0,
    jigglerMs: 0,
    cameraSinceMs: NO_SIGNAL,
    micSinceMs: NO_SIGNAL,
    jigglerSinceMs: NO_SIGNAL,
    ...overrides,
  };
}

describe("the open-interval journal", () => {
  it("keeps exactly one row, however often it is written", () => {
    const db = openTestDb();
    writeJournal(db, snapshotFromOpen(open(), "personal"));
    writeJournal(db, snapshotFromOpen(open({ keyEvents: 401 }), "personal"));
    writeJournal(db, snapshotFromOpen(open({ id: "open-2" }), "personal"));
    expect(db.prepare("SELECT COUNT(*) AS c FROM open_interval").get()).toMatchObject({ c: 1 });
    expect(readJournal(db)?.id).toBe("open-2");
  });

  it("stores the last REAL signal, never the write time", () => {
    const db = openTestDb();
    const wallClockAtWrite = t("2026-08-17T10:14:59Z"); // a quarter hour later
    writeJournal(db, snapshotFromOpen(open(), "personal"));
    const snap = readJournal(db);
    expect(snap?.lastSignalMs).toBe(LAST_SIGNAL);
    expect(snap?.lastSignalMs).not.toBe(wallClockAtWrite);
    // The gap between them is exactly the phantom time this column protects.
    expect(wallClockAtWrite - (snap?.lastSignalMs ?? 0)).toBe(899_000);
  });

  it("seals an open camera span at the last real signal, not at the write", () => {
    const db = openTestDb();
    writeJournal(
      db,
      snapshotFromOpen(
        open({ cameraSinceMs: t("2026-08-17T09:30:00Z"), jigglerSinceMs: t("2026-08-17T09:45:00Z") }),
        "personal",
      ),
    );
    const snap = readJournal(db);
    expect(snap?.cameraS).toBe(1800); // 09:30 → 10:00
    expect(snap?.jigglerS).toBe(900); // 09:45 → 10:00
  });

  it("adds an open span to what was already accumulated", () => {
    const db = openTestDb();
    writeJournal(
      db,
      snapshotFromOpen(open({ cameraMs: 600_000, cameraSinceMs: t("2026-08-17T09:50:00Z") }), "personal"),
    );
    expect(readJournal(db)?.cameraS).toBe(1200); // 600 s closed + 600 s open
  });

  it("removes the row on writeJournal(null)", () => {
    const db = openTestDb();
    writeJournal(db, snapshotFromOpen(open(), "personal"));
    writeJournal(db, null);
    expect(readJournal(db)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM open_interval").get()).toMatchObject({ c: 0 });
  });

  it("reads back as an OpenInterval the reducer can boot from", () => {
    const db = openTestDb();
    writeJournal(db, snapshotFromOpen(open({ cameraMs: 120_000 }), "personal"));
    const snap = readJournal(db);
    expect(snap).not.toBeNull();
    const reopened = openFromSnapshot(snap!);
    expect(reopened).toMatchObject({
      id: "open-1",
      startedAtMs: START,
      lastRealSignalMs: LAST_SIGNAL,
      lastInputMs: LAST_SIGNAL,
      keyEvents: 400,
      mouseEvents: 90,
      cameraMs: 120_000,
      startSource: "recovery",
      cameraSinceMs: NO_SIGNAL,
      micSinceMs: NO_SIGNAL,
      jigglerSinceMs: NO_SIGNAL,
    });
  });

  it("does not invent input evidence that was never journalled", () => {
    const db = openTestDb();
    // A camera-only session: no keys, no mouse.
    writeJournal(db, snapshotFromOpen(open({ keyEvents: 0, mouseEvents: 0 }), "personal"));
    const reopened = openFromSnapshot(readJournal(db)!);
    expect(reopened.lastInputMs).toBe(NO_SIGNAL);
    expect(reopened.lastRealSignalMs).toBe(LAST_SIGNAL);
  });
});
