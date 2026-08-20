/**
 * The close rule, enforced by the database.
 *
 * "An interval ends at the timestamp of the last real signal. Never at the
 * moment the countdown fired. Never `now()`."
 *
 * These tests exist so that a future change which writes `ended_at = now()`
 * fails loudly here instead of silently inflating every number in the product.
 */
import { describe, it, expect } from "vitest";
import { insertClosed, rowFromClosed } from "../../src/store/intervals";
import type { ClosedInterval } from "../../src/core/types";
import { NO_SIGNAL } from "../../src/core/types";
import { makeRow, openTestDb, t } from "../fakes/seed-db";

const START = t("2026-08-17T09:00:00Z");
const LAST_SIGNAL = t("2026-08-17T10:00:00Z");
const TIMEOUT_FIRED = t("2026-08-17T10:15:00Z"); // 15 minutes later. The wrong answer.

describe("the database rejects any row whose end is not the last signal", () => {
  it("rejects a raw INSERT with ended_at_ms > last_signal_at_ms", () => {
    const db = openTestDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_interval
             (id,machine_id,started_at_ms,ended_at_ms,last_signal_at_ms,duration_s,end_reason,
              tz,local_date,app_version,closed_local_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "x",
          "personal",
          START,
          TIMEOUT_FIRED,
          LAST_SIGNAL,
          4500,
          "idle_timeout",
          "UTC",
          "2026-08-17",
          "0.1.0",
          TIMEOUT_FIRED,
        ),
    ).toThrow(/CHECK constraint failed/);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM work_interval").get(),
    ).toMatchObject({ c: 0 });
  });

  it("rejects insertClosed() when the row ends after its last signal", () => {
    const db = openTestDb();
    const row = makeRow({
      id: "x",
      machineId: "personal",
      start: "2026-08-17T09:00:00Z",
      end: "2026-08-17T10:15:00Z",
      lastSignalAtMs: LAST_SIGNAL,
    });
    expect(() => insertClosed(db, row)).toThrow(/CHECK constraint failed/);
  });

  it("rejects a row that ends BEFORE its last signal too", () => {
    const db = openTestDb();
    const row = makeRow({
      id: "x",
      machineId: "personal",
      start: "2026-08-17T09:00:00Z",
      end: "2026-08-17T09:59:00Z",
      lastSignalAtMs: LAST_SIGNAL,
    });
    expect(() => insertClosed(db, row)).toThrow(/CHECK constraint failed/);
  });

  it("rejects a ClosedInterval whose endedAtMs drifted towards now()", () => {
    const db = openTestDb();
    const interval: ClosedInterval = {
      id: "x",
      startedAtMs: START,
      startSource: "input",
      lastRealSignalMs: LAST_SIGNAL,
      lastInputMs: LAST_SIGNAL,
      keyEvents: 10,
      mouseEvents: 2,
      cameraMs: 0,
      micMs: 0,
      jigglerMs: 0,
      // The bug: the countdown instant, not the last signal.
      endedAtMs: TIMEOUT_FIRED,
      durationS: 4500,
      endReason: "idle_timeout",
    };
    const row = rowFromClosed(interval, {
      machineId: "personal",
      tz: "UTC",
      appVersion: "0.1.0",
      closedLocalMs: TIMEOUT_FIRED,
    });
    expect(() => insertClosed(db, row)).toThrow(/CHECK constraint failed/);
  });

  it("accepts the correct row: it ends at the last real signal", () => {
    const db = openTestDb();
    const interval: ClosedInterval = {
      id: "x",
      startedAtMs: START,
      startSource: "input",
      lastRealSignalMs: LAST_SIGNAL,
      lastInputMs: LAST_SIGNAL,
      keyEvents: 10,
      mouseEvents: 2,
      cameraMs: 90_000,
      micMs: 0,
      jigglerMs: 0,
      endedAtMs: LAST_SIGNAL,
      durationS: 3600,
      endReason: "idle_timeout",
    };
    const row = rowFromClosed(interval, {
      machineId: "personal",
      tz: "UTC",
      appVersion: "0.1.0",
      closedLocalMs: TIMEOUT_FIRED,
    });
    expect(insertClosed(db, row)).toBe(true);
    expect(
      db.prepare("SELECT ended_at_ms, camera_s, local_date FROM work_interval").get(),
    ).toMatchObject({ ended_at_ms: LAST_SIGNAL, camera_s: 90, local_date: "2026-08-17" });
    // The wall clock at close is kept, but only as a skew diagnostic.
    expect(
      db.prepare("SELECT closed_local_ms FROM work_interval").get(),
    ).toMatchObject({ closed_local_ms: TIMEOUT_FIRED });
    expect(NO_SIGNAL).toBeLessThan(0);
  });
});
