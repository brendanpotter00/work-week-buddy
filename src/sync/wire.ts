/**
 * The wire format — the one place snake_case meets camelCase.
 *
 * The Worker's table is `docs/DATA_MODEL.md` verbatim, so every field that
 * crosses the network is named exactly as the column is. `worker/src/routes.ts`
 * `COLS` is the authority on both the names and their order, and `WireRow`
 * below is that list, in that order, so a diff of two payloads reads down the
 * same lines every time.
 *
 * Two fields are sent and then ignored:
 *
 *   `machine_id` is stamped by the Worker from the bearer token, never read
 *   from the body — a stolen token cannot forge the other Mac's rows.
 *   `server_ms` is stamped from the Worker's own clock.
 *
 * They are sent anyway because omitting a column the server names in its INSERT
 * would rely on a DEFAULT that does not exist for either. The values we send
 * are discarded server-side; the values that come back on a pull are the
 * server's.
 */
import type { CloudPayload, IntervalRow } from "../store/intervals";

/** The payload columns, in `worker/src/routes.ts` COLS order. */
export interface WireRow {
  readonly id: string;
  readonly machine_id: string;
  readonly started_at_ms: number;
  /** The LAST REAL SIGNAL. Never the timeout instant, never `now()`. */
  readonly ended_at_ms: number;
  readonly duration_s: number;
  readonly end_reason: string;
  readonly tz: string;
  readonly local_date: string;
  readonly key_events: number;
  readonly mouse_events: number;
  readonly camera_s: number;
  readonly jiggler_s: number;
  readonly app_version: string;
  readonly schema_v: number;
  readonly closed_local_ms: number;
  readonly server_ms: number | null;
}

/** A row as the cloud hands it back: every wire column plus its `seq`. */
export interface CloudRow extends WireRow {
  readonly seq: number;
}

/** Local row → upload payload. `synced_at_ms` and `cloud_seq` never travel. */
export function toWireRow(row: IntervalRow): WireRow {
  return {
    id: row.id,
    machine_id: row.machineId,
    started_at_ms: row.startedAtMs,
    ended_at_ms: row.endedAtMs,
    duration_s: row.durationS,
    end_reason: row.endReason,
    tz: row.tz,
    local_date: row.localDate,
    key_events: row.keyEvents,
    mouse_events: row.mouseEvents,
    camera_s: row.cameraS,
    jiggler_s: row.jigglerS,
    app_version: row.appVersion,
    schema_v: row.schemaV,
    closed_local_ms: row.closedLocalMs,
    server_ms: row.serverMs,
  };
}

/**
 * A pulled row → the store's ingest shape.
 *
 * Validating rather than casting is deliberate. JSON arrives as `unknown`, and
 * a missing numeric column would become `undefined`, then `NaN`, then a
 * plausible-looking wrong duration several layers away with nothing thrown.
 * A malformed row is a broken deploy or a corrupted response, and both should
 * stop the pull loudly instead of writing quiet zeroes into the mirror.
 *
 * There is no `last_signal_at_ms` on the wire. The cloud does not need one:
 * `ended_at_ms` *is* the last signal, and `ingest()` re-derives the column so
 * the local CHECK constraint holds over rows written on the other Mac.
 */
export function fromCloudRow(raw: unknown): CloudPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cloud row: expected an object, got ${describe(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  return {
    id: str(r, "id"),
    machineId: str(r, "machine_id"),
    startedAtMs: num(r, "started_at_ms"),
    endedAtMs: num(r, "ended_at_ms"),
    durationS: num(r, "duration_s"),
    endReason: str(r, "end_reason"),
    tz: str(r, "tz"),
    localDate: str(r, "local_date"),
    keyEvents: num(r, "key_events"),
    mouseEvents: num(r, "mouse_events"),
    cameraS: num(r, "camera_s"),
    jigglerS: num(r, "jiggler_s"),
    appVersion: str(r, "app_version"),
    schemaV: num(r, "schema_v"),
    closedLocalMs: num(r, "closed_local_ms"),
    serverMs: numOrNull(r, "server_ms"),
    // The pull watermark. A row without one cannot advance it, so a missing
    // `seq` is fatal here rather than a silently stalled watermark.
    cloudSeq: num(r, "seq"),
  };
}

function num(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Error(`cloud row ${idOf(r)}: ${key} is not a number: ${describe(v)}`);
}

function numOrNull(r: Record<string, unknown>, key: string): number | null {
  return r[key] === null || r[key] === undefined ? null : num(r, key);
}

function str(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v === "string") return v;
  throw new Error(`cloud row ${idOf(r)}: ${key} is not text: ${describe(v)}`);
}

function idOf(r: Record<string, unknown>): string {
  return typeof r["id"] === "string" ? `'${r["id"]}'` : "<no id>";
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined (no such column?)";
  if (v === null) return "null";
  return `${typeof v} ${String(v)}`;
}
