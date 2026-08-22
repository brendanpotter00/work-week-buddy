# IMPL_STORE_SYNC — local store, the outbox, and the Worker

**Tasks 3.1, 3.2, 4.1–4.4.**

Two stores, one dialect. Cloudflare D1 *is* SQLite, so the cloud schema and the local mirror share a dialect and the metric queries run unchanged against either. That is not a coincidence — it is most of why D1 was chosen.

**The local mirror is the outbox.** There is no separate queue table. Do not add one.

---

## 1. `src/store/db.ts`

```ts
import { DatabaseSync } from "node:sqlite";   // built into Electron 43's Node 24
import { app } from "electron";               // ← only in the factory, not the queries
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

export function defaultDbPath(): string {
  const dir = join(app.getPath("userData"), "db");
  mkdirSync(dir, { recursive: true });
  return join(dir, "local.db");
}
```

**Migrations** are a single `user_version` ladder. Ten years of schema change is the thing most likely to break a personal project, so keep it dumb: forward-only, each step idempotent, never a rename.

```ts
const STEPS: ReadonlyArray<(db: DatabaseSync) => void> = [
  (db) => db.exec(SCHEMA_V1),
];

function migrate(db: DatabaseSync): void {
  const cur = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = cur.user_version; v < STEPS.length; v++) {
    db.exec("BEGIN");
    try { STEPS[v]!(db); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
}
```

`SCHEMA_V1` is the DDL in `docs/DATA_MODEL.md`, verbatim, plus the two views.

**The CHECK constraint that makes the close rule structural** is in that DDL and must not be dropped:

```sql
CHECK (ended_at_ms = last_signal_at_ms)
```

An agent that later writes `ended_at = now()` gets a loud constraint violation instead of silently inflating every number in the product.

---

## 2. `src/store/intervals.ts`

```ts
import type { ClosedInterval } from "@/core/types";

export interface IntervalRow extends ClosedInterval {
  readonly machineId: string;
  readonly tz: string;
  readonly localDate: string;   // 'YYYY-MM-DD' of startedAtMs in tz
  readonly appVersion: string;
  readonly cloudSeq: number | null;
  readonly syncedAtMs: number | null;
}

/** The ONLY way a row is created. Client-minted id, so retries are idempotent
 *  forever. Never an UPDATE — a closed interval is immutable. */
export function insertClosed(db: DatabaseSync, row: IntervalRow): void;

/** Rows awaiting upload, oldest first. The mirror IS the outbox. */
export function pendingRows(db: DatabaseSync, limit = 200): IntervalRow[];

/** Called ONLY after an HTTP 200, and keyed on the ids the server reports
 *  PRESENT — never on what the INSERT claimed to affect. See §5. */
export function markSynced(db: DatabaseSync, present: Array<{ id: string; seq: number }>, atMs: number): void;

/** Ingest rows pulled from the cloud. INSERT OR IGNORE — arriving twice,
 *  out of order, or three weeks late are all the same thing. */
export function ingest(db: DatabaseSync, rows: IntervalRow[]): number;
```

`localDate` is computed **client-side at close time** with `Intl.DateTimeFormat` in the interval's own IANA zone, and stored. Converting UTC to a per-row zone is not an immutable SQL expression, and storing it turns every heatmap query into a plain `GROUP BY`. It also stays correct when you travel, because the row remembers the zone it happened in.

---

## 3. `src/store/journal.ts` — crash safety

One row, rewritten on every signal batch. This is what makes a `kill -9` cost under 30 seconds instead of a whole session.

```ts
/** Upsert the single open-interval row. Called from the `journal` effect. */
export function writeJournal(db: DatabaseSync, open: OpenInterval | null): void;

/** Read it at boot. Feeds straight into reduce({kind:'boot', journalled}). */
export function readJournal(db: DatabaseSync): OpenInterval | null;
```

**The boot sequence, in order:**

1. `openDb()` — migrations run.
2. `readJournal()`.
3. `reduce(initialState, { kind: "boot", atMs: Date.now(), journalled }, cfg, now)`.
4. Apply the effects. If the journal was stale, this persists a `crash_recovered` interval ending at the pre-sleep signal.
5. `flush()` — anything queued from before the crash goes out.
6. `pull()`.

There is no separate recovery path. Boot is a transition like any other, which is exactly why sleep, force-quit, power loss and reboot need no code of their own.

**Single instance.** Two processes writing one SQLite file and both holding an event tap is a corruption you would not notice for weeks:

```ts
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
```

---

## 4. `src/store/queries.ts`

The six queries from `docs/DATA_MODEL.md`, each behind a typed function. **Policy lives in the `v_countable` view and nowhere else** — if a product decision starts leaking into TypeScript, put it back in the view.

```ts
export interface Policy {
  readonly graceS: number;            // 0 — the idle window is not credited
  readonly minIntervalS: number;      // 90
  readonly countJigglerTime: boolean; // false — PRD D1 = (a)
  readonly weekStart: 0 | 1;          // 1 = Monday
  readonly levelStepH: number;
}

export function hoursThisWeek(db: DatabaseSync, p: Policy, tz: string): number;
export function avgIntervalThisWeek(db: DatabaseSync, p: Policy, tz: string): { minutes: number; n: number };
export function avgIntervalAllTime(db: DatabaseSync, p: Policy): { minutes: number; n: number };
export function longestInterval(db: DatabaseSync, p: Policy): { hours: number; localDate: string; machineId: string };
export function heatmap(db: DatabaseSync, p: Policy): Array<{ date: string; count: number; level: 0|1|2|3|4 }>;
export function byMachine(db: DatabaseSync, p: Policy, tz: string): Array<{ label: string; hours: number; meetingHours: number; jigglerHours: number }>;
/** The honesty widget — both numbers, so cross-machine overlap is visible. */
export function unionVsSum(db: DatabaseSync, p: Policy, localDate: string): { naiveSumH: number; unionH: number };
```

Week boundaries are computed **in TypeScript** from the display timezone and passed in as bound parameters. Never `date(…, 'localtime')` — it is DST-naive and wrong when you travel.

---

## 5. `src/sync/flush.ts` — the part that must be idempotent

```ts
let inFlight = false;
let backoffMs = 0;

export async function flush(db: DatabaseSync, client: WorkerClient, machineId: string): Promise<void> {
  if (inFlight) return;                 // single-flight, always
  inFlight = true;
  try {
    for (;;) {
      const rows = pendingRows(db, 200);
      if (rows.length === 0) { backoffMs = 0; return; }   // drained; the timer dies with it

      let res: PostResult;
      try {
        res = await client.postIntervals(machineId, rows);
      } catch {
        scheduleBackoff();               // a failed fetch IS the network signal.
        return;                          // No reachability API, no ping, no probe.
      }
      if (!res.ok) { scheduleBackoff(); return; }

      // ── THE RULE ─────────────────────────────────────────────────────────
      // Mark on PRESENCE, from the server's own read-back — never before the
      // 200, and never on what the INSERT reported. If the response is lost
      // AFTER the server committed, the retry re-sends identical ids,
      // ON CONFLICT DO NOTHING no-ops, and the presence query still reports
      // them — so they get marked on the next attempt instead of being
      // uploaded forever or, worse, marked when they never landed.
      markSynced(db, res.present, Date.now());
      setSyncState(db, "last_cloud_write_ms", String(Date.now()));
    }
  } finally { inFlight = false; }
}

function scheduleBackoff() {
  // 30s → 1m → 2m → 5m → 15m, ±20% jitter. The timer exists ONLY while
  // pending > 0, so an idle app has no sync timer at all.
  backoffMs = backoffMs === 0 ? 30_000 : Math.min(backoffMs * 2, 900_000);
  const jitter = backoffMs * (0.8 + Math.random() * 0.4);
  setTimeout(() => void flush(...), jitter);
}
```

`flush()` is called on: interval close, `powerMonitor` `resume`, app launch, and backoff retry. Nothing else.

---

## 6. `src/sync/pull.ts`

```ts
export async function pull(db: DatabaseSync, client: WorkerClient): Promise<number> {
  let watermark = Number(getSyncState(db, "pull_watermark") ?? 0);
  let ingested = 0;
  for (;;) {
    // ── The 200-row overlap is NOT optional. `seq` comes from an AUTOINCREMENT,
    //    and identity values can become visible out of order under concurrent
    //    inserts. A strict `seq > watermark` can therefore skip a row
    //    permanently — silently, and you would never find it. INSERT OR IGNORE
    //    makes re-reading those 200 rows free. There is a test for this.
    const since = Math.max(0, watermark - 200);
    const page = await client.getIntervals(since, 1000);
    if (page.rows.length === 0) break;
    ingested += ingest(db, page.rows);
    const maxSeq = Math.max(...page.rows.map((r) => r.cloudSeq ?? 0));
    if (maxSeq <= watermark) break;      // no forward progress; stop
    watermark = maxSeq;
    setSyncState(db, "pull_watermark", String(watermark));
  }
  return ingested;
}
```

Called on launch, on wake, and after each successful flush.

**The dashboard never reads the cloud.** A menu-bar popover has to paint in under 16 ms, has to work on a plane, and has to work while a VPN is down. The cloud is a reconciliation target, never a render path.

---

## 7. The Worker

`worker/src/index.ts`, complete.

```ts
export interface Env {
  /** The only binding. Credentials are ROWS, not bindings — see below. */
  DB: D1Database;
}

/** SHA-256, lowercase hex — the format `machine_token.token_sha256` stores. */
async function sha256Hex(sV: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sV));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the machine this token IS, or null.
 *  The machine id comes FROM THE CREDENTIAL, never from the request body — so a
 *  stolen token cannot forge another machine's rows. Nothing is hardcoded to
 *  two: the registry is a table, and a machine enrols itself.
 *  A read failure throws `RegistryUnavailable`, which index.ts maps to 503 —
 *  a Worker deployed without its schema must not answer "your token is wrong". */
async function authenticate(req: Request, env: Env): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return null;
  const row = await env.DB.prepare(
    `SELECT machine_id FROM machine_token
      WHERE token_sha256 = ? AND revoked_at_ms IS NULL`,
  ).bind(await sha256Hex(presented)).first<{ machine_id: string }>();
  return row === null || row.machine_id === "" ? null : row.machine_id;
  }
  return null;
}

const COLS = [
  "id","machine_id","started_at_ms","ended_at_ms","duration_s","end_reason","tz",
  "local_date","key_events","mouse_events","camera_s","jiggler_s","app_version",
  "schema_v","closed_local_ms","server_ms",
] as const;

// D1 caps bound parameters at 100 per statement. 16 columns ⇒ 6 rows per
// statement, batched. Exceeding it fails the whole request, so chunk.
const ROWS_PER_STMT = Math.floor(100 / COLS.length);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const machineId = await authenticate(req, env);
    if (!machineId) return new Response("unauthorized", { status: 401 });

    // ── POST /intervals ────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/intervals") {
      const { rows } = await req.json<{ rows: Array<Record<string, unknown>> }>();
      if (!Array.isArray(rows) || rows.length === 0) return Response.json({ present: [] });
      if (rows.length > 500) return new Response("too many rows", { status: 413 });

      const serverMs = Date.now();
      const stmts = [];
      for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
        const chunk = rows.slice(i, i + ROWS_PER_STMT);
        const placeholders = chunk.map(() => `(${COLS.map(() => "?").join(",")})`).join(",");
        const binds = chunk.flatMap((r) => COLS.map((c) =>
          c === "machine_id" ? machineId          // ← stamped, never trusted
          : c === "server_ms" ? serverMs
          : (r[c] ?? null)));
        stmts.push(env.DB.prepare(
          `INSERT INTO work_interval (${COLS.join(",")}) VALUES ${placeholders}
           ON CONFLICT(id) DO NOTHING`).bind(...binds));
      }
      await env.DB.batch(stmts);

      // Report what the server can SEE, not what the INSERT claimed. This is
      // what makes a lost response safely replayable on the client.
      const ids = rows.map((r) => String(r.id));
      const q = `SELECT id, seq FROM work_interval WHERE id IN (${ids.map(() => "?").join(",")})`;
      const present = await env.DB.prepare(q).bind(...ids).all();
      return Response.json({ present: present.results });
    }

    // ── GET /intervals?since=&limit= ───────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/intervals") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 1000);
      const r = await env.DB.prepare(
        `SELECT * FROM work_interval WHERE seq > ? ORDER BY seq LIMIT ?`).bind(since, limit).all();
      return Response.json({ rows: r.results });
    }

    // ── POST /heartbeat ────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const b = await req.json<{ label?: string; osVersion?: string; appVersion?: string }>();
      await env.DB.prepare(
        `INSERT INTO machine (machine_id,label,os_version,app_version,last_seen_ms)
         VALUES (?,?,?,?,?)
         ON CONFLICT(machine_id) DO UPDATE SET
           label=excluded.label, os_version=excluded.os_version,
           app_version=excluded.app_version,
           -- commutative: an out-of-order heartbeat can never move it backwards
           last_seen_ms=MAX(machine.last_seen_ms, excluded.last_seen_ms)`)
        .bind(machineId, b.label ?? machineId, b.osVersion ?? "", b.appVersion ?? "", Date.now()).run();
      return Response.json({ ok: true });
    }

    // ── GET /fingerprint ───────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/fingerprint") {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS count, COALESCE(MAX(ended_at_ms),0) AS max_ended_at_ms,
                COALESCE(group_concat(id), '') AS ids
         FROM (SELECT id, ended_at_ms FROM work_interval ORDER BY id)`).first<{
          count: number; max_ended_at_ms: number; ids: string }>();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r!.ids));
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return Response.json({ count: r!.count, maxEndedAtMs: r!.max_ended_at_ms, sha256: sha });
    }

    // Everything else, including DELETE and UPDATE, is unreachable. The route
    // surface IS the enforcement — not a comment, not a convention, not a role.
    return new Response("not found", { status: 404 });
  },
};
```

`worker/wrangler.toml`:

```toml
name = "wwb-sync"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "wwb"
database_id = "REPLACE_AFTER_wrangler_d1_create"
```

**The Worker reads no secrets and no environment variables.** Its only binding is `DB`. Per-machine bearer tokens used to be `secret_text` bindings; they are rows in `machine_token` inside the database, holding a SHA-256 and never a token. Two footguns went with them: an upload can no longer silently delete another Mac's credential (there is nothing to inherit), and revoking a Mac is one `UPDATE` rather than a `wrangler secret put`.

**Client-side**, the token goes through Electron `safeStorage.encryptString` into a file in Application Support, which is backed by the macOS Keychain. Never a plist, never a dotfile, never the asar.

---

## 8. Backups

Four layers, no command ever typed. Layers 2 and 3 are **load-bearing**, not nice-to-have, because D1's free Time Travel window is only 7 days.

| Layer | Implementation |
|---|---|
| **1. Two full local mirrors** | Falls out of the design. Total vendor loss ⇒ `UPDATE work_interval SET synced_at_ms = NULL` on either Mac and the flush loop rebuilds the cloud. |
| **2. Weekly self-export** | First launch each week: write `wwb-YYYY-Www.sqlite` and `.ndjson.gz` to iCloud Drive if present, else `~/Documents/WorkWeekBuddy/backups/`. Keep 52. **NDJSON deliberately** — it restores into any future backend, which is what makes vendor exit cheap. |
| **3. Fingerprint reconciliation** | Weekly: `GET /fingerprint`, compute the same locally over synced rows, compare. Mismatch ⇒ tray badge + `log`. **This is the layer that catches *silent* loss.** Without it the backups are theatre, because you never learn you needed them. |
| **4. Silence alarm** | `last_cloud_write_ms` older than 72 h ⇒ change the tray icon and post a notification. This is what catches a free-tier policy change in 2031 when nobody is reading email from Cloudflare. |

---

## 9. Tests

### Store

| Test | Assertion |
|---|---|
| `crash recovery` | write a journal, simulate an unclean exit, reopen ⇒ interval closed at `last_signal_ms`, `end_reason='crash_recovered'`, under 30 s lost |
| `close rule is enforced by the DB` | attempt `INSERT … ended_at_ms = now` with `last_signal_at_ms` earlier ⇒ **constraint violation** |
| `union merge — overlapping` | two machines 09:00–10:00 and 09:30–10:30 ⇒ 1.5 h, not 2 |
| `union merge — nested` | 09:00–11:00 and 09:30–10:00 ⇒ 2 h |
| `union merge — adjacent` | 09:00–10:00 and 10:00–11:00 ⇒ 2 h, one island |
| `union merge — crossing midnight` | attributed wholly to the start day, per the documented simplification |
| `metrics against a seeded DB` | each of the six queries returns hand-computed numbers |
| `rows are never deleted` | exclusion changes results; `COUNT(*)` is unchanged |

### Sync

| Test | Assertion |
|---|---|
| `offline then reconnect` | 6 intervals recorded with the client throwing, then reconnect ⇒ all 6 land, **none duplicated** |
| `kill mid-flush` | server commits, response is dropped ⇒ retry re-sends, server no-ops, rows end up marked exactly once |
| `never marked before 200` | a non-2xx response ⇒ `synced_at_ms` is still NULL for every row |
| `pull overlap skips nothing` | insert rows whose `seq` becomes visible out of order ⇒ every row is ingested |
| `backoff dies when drained` | after a successful drain, no sync timer remains armed |

### Worker (against `worker/test/fake-d1.ts`, a `node:sqlite`-backed D1 double, so the SQL is exercised in the same dialect)

| Test | Assertion |
|---|---|
| `a token in no registry row` | 401, and nothing written |
| `a REVOKED token` | 401 — the revocation guarantee, effective on the next request |
| `registry empty` | `/health` 200, everything else 401 — fail closed |
| `registry table missing` | `/health` 200, everything else **503**, never 401 |
| `machine_id cannot be forged` | body claims another machine ⇒ the stored row carries the token's own id |
| `the hash agrees across implementations` | `node:crypto` (enrolment) and WebCrypto (the Worker) produce the same digest |
| `DELETE and UPDATE unreachable` | both ⇒ 404 |
| `duplicate insert is a no-op` | same id twice ⇒ one row, and **both** responses report it present |
| `bound-parameter cap` | 50 rows in one request ⇒ chunked, all land, no error |
| `fingerprint is stable` | same rows in a different insert order ⇒ identical sha |

### End to end

| Test | Assertion |
|---|---|
| `two machines converge` | two local DBs + one fake cloud, 200 interleaved pushes and pulls, one machine offline for a simulated 3 weeks ⇒ **byte-identical** interval sets |
| `wipe the cloud and rebuild` | truncate the cloud, mark local rows unsynced, flush ⇒ the cloud is fully reconstructed |
