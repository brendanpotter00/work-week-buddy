import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  countIntervals,
  getRow,
  ingest,
  insertClosed,
  markSynced,
  pendingRows,
  type CloudPayload,
} from "../../src/store/intervals";
import { makeRow, openTestDb, seed, t } from "../fakes/seed-db";

describe("closed intervals", () => {
  it("is idempotent on the same id — a retry three weeks later is the same insert", () => {
    const db = openTestDb();
    const row = makeRow({
      id: "a",
      machineId: "personal",
      start: "2026-08-17T09:00:00Z",
      end: "2026-08-17T10:00:00Z",
    });
    expect(insertClosed(db, row)).toBe(true);
    expect(insertClosed(db, row)).toBe(false);
    expect(insertClosed(db, { ...row, keyEvents: 999 })).toBe(false);
    expect(countIntervals(db)).toBe(1);
    // ON CONFLICT DO NOTHING, never DO UPDATE: the first write wins and a
    // closed interval is immutable.
    expect(getRow(db, "a")?.keyEvents).toBe(0);
  });

  it("returns only unsynced rows from the outbox, oldest first", () => {
    const db = openTestDb();
    seed(db, [
      { id: "late", machineId: "personal", start: "2026-08-17T14:00:00Z", end: "2026-08-17T15:00:00Z" },
      { id: "early", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      {
        id: "done",
        machineId: "personal",
        start: "2026-08-17T07:00:00Z",
        end: "2026-08-17T08:00:00Z",
        syncedAtMs: 1,
        cloudSeq: 7,
      },
    ]);
    expect(pendingRows(db).map((r) => r.id)).toEqual(["early", "late"]);
    expect(pendingRows(db, 1).map((r) => r.id)).toEqual(["early"]);
  });

  it("marks synced only from the ids the server reports present", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
      { id: "b", machineId: "personal", start: "2026-08-17T11:00:00Z", end: "2026-08-17T12:00:00Z" },
    ]);
    markSynced(db, [{ id: "a", seq: 41 }], 1000);
    expect(getRow(db, "a")).toMatchObject({ cloudSeq: 41, syncedAtMs: 1000 });
    expect(getRow(db, "b")).toMatchObject({ cloudSeq: null, syncedAtMs: null });
    expect(pendingRows(db).map((r) => r.id)).toEqual(["b"]);
  });

  it("does not move synced_at_ms when a lost response is replayed", () => {
    const db = openTestDb();
    seed(db, [
      { id: "a", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    markSynced(db, [{ id: "a", seq: 41 }], 1000);
    markSynced(db, [{ id: "a", seq: 41 }], 9999);
    expect(getRow(db, "a")).toMatchObject({ cloudSeq: 41, syncedAtMs: 1000 });
  });

  it("ingests cloud rows once, derives last_signal_at_ms, and keeps them out of the outbox", () => {
    const db = openTestDb();
    const payload: CloudPayload = {
      id: "from-work-mac",
      machineId: "work",
      startedAtMs: t("2026-08-17T09:00:00Z"),
      endedAtMs: t("2026-08-17T10:00:00Z"),
      durationS: 3600,
      endReason: "idle_timeout",
      tz: "America/Chicago",
      localDate: "2026-08-17",
      keyEvents: 12,
      mouseEvents: 3,
      cameraS: 0,
      jigglerS: 0,
      appVersion: "0.1.0",
      schemaV: 1,
      closedLocalMs: t("2026-08-17T10:00:00Z"),
      serverMs: t("2026-08-17T10:00:05Z"),
      cloudSeq: 12,
    };
    expect(ingest(db, [payload], 5000)).toBe(1);
    // Arriving twice, out of order, or three weeks late are the same thing.
    expect(ingest(db, [payload], 6000)).toBe(0);
    expect(countIntervals(db)).toBe(1);
    expect(getRow(db, "from-work-mac")).toMatchObject({
      lastSignalAtMs: payload.endedAtMs,
      cloudSeq: 12,
      syncedAtMs: 5000,
    });
    expect(pendingRows(db)).toEqual([]);
  });

  it("rejects an ingested row whose end is not its last signal", () => {
    const db = openTestDb();
    // The cloud has no last_signal_at_ms column, so ingest derives it from
    // ended_at_ms. The only way this row can be wrong is if the machine that
    // wrote it violated the close rule — and its own CHECK would have stopped
    // that. Proving the constraint still applies to ingested rows:
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_interval
             (id,machine_id,started_at_ms,ended_at_ms,last_signal_at_ms,duration_s,end_reason,
              tz,local_date,app_version,closed_local_ms,cloud_seq,synced_at_ms)
           VALUES ('z','work',1,3,2,1,'idle_timeout','UTC','2026-08-17','0.1.0',3,9,9)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("rows are never deleted or updated", () => {
  const dir = fileURLToPath(new URL("../../src/store", import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: stripComments(readFileSync(join(dir, f), "utf8")) }));

  it("issues no DELETE against work_interval anywhere in src/store", () => {
    for (const { file, text } of sources) {
      expect(`${file}: ${String(/DELETE\s+FROM\s+work_interval/i.test(text))}`).toBe(`${file}: false`);
    }
  });

  it("issues no UPDATE against a payload column anywhere in src/store", () => {
    const allowed = new Set(["cloud_seq", "synced_at_ms"]);
    for (const { file, text } of sources) {
      // The terminator is optional on purpose: `UPDATE work_interval SET
      // key_events = 0` with no WHERE at all is the worst case this guard
      // exists for, and a regex that requires WHERE would sail straight past it.
      for (const m of text.matchAll(
        /UPDATE\s+work_interval\s+SET\s+([\s\S]*?)(?:\bWHERE\b|;|`|$)/gim,
      )) {
        const set = m[1] ?? "";
        const assigned = [...set.matchAll(/([a-z_]+)\s*=/gi)].map((x) =>
          (x[1] ?? "").toLowerCase(),
        );
        for (const col of assigned) {
          expect(`${file}: ${col}`).toBe(`${file}: ${allowed.has(col) ? col : "a payload column"}`);
        }
      }
    }
  });

  it("never asks SQLite for the local clock", () => {
    // date(…, 'localtime') is DST-naive and wrong when travelling. Week
    // boundaries are computed in TypeScript and bound as parameters.
    for (const { file, text } of sources) {
      expect(`${file}: ${String(text.includes("localtime"))}`).toBe(`${file}: false`);
    }
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
