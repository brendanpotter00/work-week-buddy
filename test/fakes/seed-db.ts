/**
 * Seeded databases for the store tests.
 *
 * Every fixture is built in UTC unless a test says otherwise, so the expected
 * numbers can be computed by hand from the clock times in the spec rather than
 * from whatever zone the machine running CI happens to be in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/store/db";
import { insertClosed, type IntervalRow } from "../../src/store/intervals";
import type { Policy } from "../../src/store/policy";
import { upsertMachine } from "../../src/store/sync-state";

export const TZ = "UTC";

/** '2026-08-17T09:00Z' → epoch ms. Throws on anything unparseable. */
export function t(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparseable instant: ${iso}`);
  return ms;
}

export function openTestDb(policy?: Policy): DatabaseSync {
  return policy === undefined ? openDb(":memory:") : openDb(":memory:", policy);
}

/** A throwaway directory that survives a process being SIGKILLed inside it. */
export function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wwb-store-"));
  return { path: join(dir, "local.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RowSpec {
  readonly id: string;
  readonly machineId: string;
  /** ISO instant of the first real signal. */
  readonly start: string;
  /** ISO instant of the LAST REAL SIGNAL. */
  readonly end: string;
  readonly localDate?: string;
  readonly endReason?: string;
  readonly tz?: string;
  readonly keyEvents?: number;
  readonly mouseEvents?: number;
  readonly cameraS?: number;
  readonly jigglerS?: number;
  readonly syncedAtMs?: number | null;
  readonly cloudSeq?: number | null;
  /** Only a test that is deliberately breaking the close rule sets this. */
  readonly lastSignalAtMs?: number;
}

export function makeRow(spec: RowSpec): IntervalRow {
  const startedAtMs = t(spec.start);
  const endedAtMs = t(spec.end);
  const tz = spec.tz ?? TZ;
  return {
    id: spec.id,
    machineId: spec.machineId,
    startedAtMs,
    endedAtMs,
    lastSignalAtMs: spec.lastSignalAtMs ?? endedAtMs,
    durationS: Math.round((endedAtMs - startedAtMs) / 1000),
    endReason: spec.endReason ?? "idle_timeout",
    tz,
    localDate: spec.localDate ?? spec.start.slice(0, 10),
    keyEvents: spec.keyEvents ?? 0,
    mouseEvents: spec.mouseEvents ?? 0,
    cameraS: spec.cameraS ?? 0,
    jigglerS: spec.jigglerS ?? 0,
    appVersion: "0.1.0",
    schemaV: 1,
    closedLocalMs: endedAtMs,
    serverMs: null,
    cloudSeq: spec.cloudSeq ?? null,
    syncedAtMs: spec.syncedAtMs ?? null,
  };
}

export function seed(db: DatabaseSync, specs: readonly RowSpec[]): IntervalRow[] {
  const rows = specs.map(makeRow);
  for (const r of rows) insertClosed(db, r);
  return rows;
}

/**
 * The metric fixture. Monday 2026-08-17 is the start of the week.
 *
 *   Mon 09:00–10:00  personal   1 h                      ┐ overlap: the
 *   Mon 09:30–10:30  work       1 h, 30 min of camera    ┘ union is 1.5 h
 *   Tue 13:00–14:00  personal   1 h
 *   Wed 09:00–09:01  personal   60 s   — under the 90 s stray-bump floor
 *   Thu 08:00–12:00  work       4 h    — wholly jiggler-covered, PRD D1 (a)
 *
 * Five rows are stored. Three of them count. Nothing is ever deleted.
 */
export const WEEK_FIXTURE: readonly RowSpec[] = [
  { id: "a", machineId: "personal", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z", keyEvents: 900, mouseEvents: 100 },
  { id: "b", machineId: "work", start: "2026-08-17T09:30:00Z", end: "2026-08-17T10:30:00Z", cameraS: 1800 },
  { id: "c", machineId: "personal", start: "2026-08-18T13:00:00Z", end: "2026-08-18T14:00:00Z" },
  { id: "d", machineId: "personal", start: "2026-08-19T09:00:00Z", end: "2026-08-19T09:01:00Z" },
  { id: "e", machineId: "work", start: "2026-08-20T08:00:00Z", end: "2026-08-20T12:00:00Z", jigglerS: 14400 },
];

/** An instant inside the fixture week: Wednesday noon UTC. */
export const NOW_IN_WEEK = t("2026-08-19T12:00:00Z");

export function seedWeek(db: DatabaseSync): void {
  seed(db, WEEK_FIXTURE);
  upsertMachine(db, { machineId: "personal", label: "personal", lastSeenMs: NOW_IN_WEEK });
  upsertMachine(db, { machineId: "work", label: "work", lastSeenMs: NOW_IN_WEEK });
}
