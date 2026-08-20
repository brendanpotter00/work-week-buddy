/**
 * The route table. Six entries, and this table is the ONLY place a method is
 * registered.
 *
 * ── There is no DELETE and no UPDATE, anywhere. ─────────────────────────────
 * docs/DATA_MODEL.md: rows are never deleted or updated; exclusion is a
 * query-time filter. The route surface IS that enforcement — not a comment, not
 * a convention, not a role. `DELETE /intervals` gets a 404 because nothing
 * answers it, which is a far stronger guarantee than a handler that declines.
 * There is a test that fails if an entry ever appears here.
 */

import { fingerprintSha256 } from "./fingerprint.js";
import type {
  D1PreparedStatement,
  Env,
  PresentRow,
} from "./types.js";

/** The wire columns, in statement order. */
export const COLS = [
  "id",
  "machine_id",
  "started_at_ms",
  "ended_at_ms",
  "duration_s",
  "end_reason",
  "tz",
  "local_date",
  "key_events",
  "mouse_events",
  "camera_s",
  "jiggler_s",
  "app_version",
  "schema_v",
  "closed_local_ms",
  "server_ms",
] as const;

/**
 * Columns whose schema DEFAULT must be honoured when the wire row omits them.
 *
 * Subtle and worth stating: naming a column in the INSERT's column list and
 * binding NULL DEFEATS its DEFAULT clause, so `NOT NULL DEFAULT 0` becomes a
 * constraint violation rather than a zero. Since every column is always named
 * here, the defaults have to be reapplied on this side. Caught by running the
 * real SQL against real SQLite — a mock would have accepted the NULL.
 */
const COL_DEFAULTS: Partial<Record<(typeof COLS)[number], number>> = {
  key_events: 0,
  mouse_events: 0,
  camera_s: 0,
  jiggler_s: 0,
  schema_v: 1,
};

/**
 * D1 caps bound parameters at 100 per statement. Exceeding it fails the whole
 * request, so both the insert and the presence read-back chunk. 16 columns
 * gives 6 rows per INSERT (96 parameters) and 100 ids per presence SELECT.
 */
export const D1_MAX_BOUND_PARAMS = 100;
export const ROWS_PER_STMT = Math.floor(D1_MAX_BOUND_PARAMS / COLS.length);
export const IDS_PER_QUERY = D1_MAX_BOUND_PARAMS;

/**
 * One upload is one drained page of the outbox, and `flush()` pages at 200.
 * A larger body is a client that has gone wrong, so say so rather than absorb it.
 */
export const MAX_ROWS_PER_REQUEST = 200;

/** Pull page size. The client applies the 200-row overlap; this stays a range read. */
export const MAX_PULL_LIMIT = 1000;

export interface RouteContext {
  readonly req: Request;
  readonly env: Env;
  readonly url: URL;
  /**
   * Derived from the bearer token, never from the body. Empty only for routes
   * declared `auth: false`, which never write.
   */
  readonly machineId: string;
}

export type Handler = (ctx: RouteContext) => Promise<Response>;

export interface Route {
  readonly auth: boolean;
  readonly handler: Handler;
}

type WireRow = Record<string, unknown>;

/** Parse a JSON body, or null if it is absent or malformed. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}

function badRequest(why: string): Response {
  return new Response(why, { status: 400 });
}

/** A finite integer from a query string, clamped, with a default for junk. */
function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ── GET /health ─────────────────────────────────────────────────────────────
// Unauthenticated on purpose: bring-up curls it from both Macs to prove the
// work Mac's proxy allows workers.dev, before any token exists. It touches no
// data and reveals nothing.
const health: Handler = async () =>
  Response.json({ ok: true, ms: Date.now() });

// ── POST /intervals ─────────────────────────────────────────────────────────
const postIntervals: Handler = async ({ req, env, machineId }) => {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null) {
    return badRequest("expected a JSON object");
  }
  const { rows } = body as { rows?: unknown };
  if (!Array.isArray(rows)) return badRequest("expected rows[]");
  if (rows.length === 0) {
    return Response.json({ present: [], server_ms: Date.now() });
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return new Response("too many rows", { status: 413 });
  }
  // `id` is client-minted and load-bearing twice over: it is the conflict
  // target that makes a retry idempotent, and it is what the presence read-back
  // keys on. A row without one cannot be answered for, so reject the batch
  // rather than silently under-report presence and strand the client's row.
  const bad = rows.findIndex(
    (r) =>
      typeof r !== "object" ||
      r === null ||
      typeof (r as WireRow)["id"] !== "string" ||
      ((r as WireRow)["id"] as string).length === 0,
  );
  if (bad !== -1) return badRequest(`row ${bad} has no id`);
  const wire = rows as WireRow[];

  const serverMs = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < wire.length; i += ROWS_PER_STMT) {
    const chunk = wire.slice(i, i + ROWS_PER_STMT);
    const placeholders = chunk
      .map(() => `(${COLS.map(() => "?").join(",")})`)
      .join(",");
    const binds = chunk.flatMap((r) =>
      COLS.map((c) =>
        // ── The forgery guard. machine_id is stamped from the token and
        //    server_ms from the Worker's clock; whatever the body claimed for
        //    either is discarded here and never reaches the database.
        c === "machine_id"
          ? machineId
          : c === "server_ms"
            ? serverMs
            : (r[c] ?? COL_DEFAULTS[c] ?? null),
      ),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO work_interval (${COLS.join(",")}) VALUES ${placeholders}
         ON CONFLICT(id) DO NOTHING`,
      ).bind(...binds),
    );
  }
  await env.DB.batch(stmts);

  // ── AGENTS.md #8 ──────────────────────────────────────────────────────────
  // Report what the server can SEE, not what the INSERT claimed. A response
  // lost AFTER the commit means the client retries with identical ids, the
  // upsert no-ops, and this query still reports them present — so they are
  // marked on the next attempt instead of being uploaded forever, or, far
  // worse, marked when they never landed.
  const ids = wire.map((r) => String(r["id"]));
  const present: PresentRow[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const chunk = ids.slice(i, i + IDS_PER_QUERY);
    const res = await env.DB.prepare(
      `SELECT id, seq FROM work_interval WHERE id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<PresentRow>();
    present.push(...res.results);
  }
  return Response.json({ present, server_ms: serverMs });
};

// ── GET /intervals?since=&limit= ────────────────────────────────────────────
const getIntervals: Handler = async ({ env, url }) => {
  const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url, "limit", MAX_PULL_LIMIT, 1, MAX_PULL_LIMIT);
  const r = await env.DB.prepare(
    `SELECT * FROM work_interval WHERE seq > ? ORDER BY seq LIMIT ?`,
  )
    .bind(since, limit)
    .all();
  return Response.json({ rows: r.results });
};

// ── POST /heartbeat ─────────────────────────────────────────────────────────
const heartbeat: Handler = async ({ req, env, machineId }) => {
  const parsed = await readJson(req);
  const b = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    label?: unknown;
    osVersion?: unknown;
    appVersion?: unknown;
  };
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  await env.DB.prepare(
    `INSERT INTO machine (machine_id,label,os_version,app_version,last_seen_ms)
     VALUES (?,?,?,?,?)
     ON CONFLICT(machine_id) DO UPDATE SET
       label=excluded.label, os_version=excluded.os_version,
       app_version=excluded.app_version,
       -- commutative: an out-of-order heartbeat can never move it backwards
       last_seen_ms=MAX(machine.last_seen_ms, excluded.last_seen_ms)`,
  )
    .bind(
      machineId,
      str(b.label, machineId),
      str(b.osVersion, ""),
      str(b.appVersion, ""),
      Date.now(),
    )
    .run();
  return Response.json({ ok: true });
};

// ── GET /machines ───────────────────────────────────────────────────────────
// The read half of the heartbeat, and the only way Mac A learns what Mac B is
// called. Without it a pulled `work_interval` row renders under a raw
// IOPlatformUUID forever, because `machine_id` is the only machine identity a
// row carries — the label is deliberately NOT denormalised onto it, so that
// renaming stays a one-row update instead of a backfill.
//
// A plain read of a table with two rows in it: no `since`, no paging, no
// watermark. Anything cleverer would be bookkeeping for a set that cannot grow
// past the number of Macs the owner has.
const getMachines: Handler = async ({ env }) => {
  const r = await env.DB.prepare(
    `SELECT machine_id, label, os_version, app_version, last_seen_ms
       FROM machine ORDER BY machine_id`,
  ).all();
  return Response.json({ machines: r.results });
};

// ── GET /fingerprint ────────────────────────────────────────────────────────
const fingerprint: Handler = async ({ env }) => {
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(ended_at_ms),0) AS max_ended_at_ms
     FROM work_interval`,
  ).first<{ count: number; max_ended_at_ms: number }>();
  // Ids are hashed in JS, not concatenated in SQL: group_concat's ordering is
  // not guaranteed across a subquery, and a fingerprint that depends on the
  // planner is a mismatch alarm waiting to happen.
  const idRows = await env.DB.prepare(
    `SELECT id FROM work_interval ORDER BY id`,
  ).all<{ id: string }>();
  const sha = await fingerprintSha256(idRows.results.map((r) => r.id));
  return Response.json({
    count: agg?.count ?? 0,
    maxEndedAtMs: agg?.max_ended_at_ms ?? 0,
    sha256: sha,
  });
};

export const ROUTES = {
  "GET /health": { auth: false, handler: health },
  "POST /intervals": { auth: true, handler: postIntervals },
  "GET /intervals": { auth: true, handler: getIntervals },
  "POST /heartbeat": { auth: true, handler: heartbeat },
  "GET /machines": { auth: true, handler: getMachines },
  "GET /fingerprint": { auth: true, handler: fingerprint },
} as const satisfies Record<string, Route>;

export type RouteKey = keyof typeof ROUTES;

/**
 * `Object.hasOwn` rather than a bare index, so an inherited property name
 * ("toString", "constructor") can never resolve to a handler.
 */
export function lookupRoute(method: string, pathname: string): Route | undefined {
  const key = `${method} ${pathname}`;
  return Object.hasOwn(ROUTES, key)
    ? (ROUTES as Record<string, Route>)[key]
    : undefined;
}
