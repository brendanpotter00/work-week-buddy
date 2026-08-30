# Data model

Two stores, one dialect. Cloudflare D1 is SQLite, so the cloud schema and the local mirror share a dialect and the metric queries run unchanged against either.

- **Cloud (D1)** — the single shared database both Macs write to.
- **Local mirror** — a full copy on each Mac. It is what the dashboard reads, and it *is* the outbox. There is no separate queue.

## Schema

```sql
-- ═══ CLOUD: Cloudflare D1
--     wrangler d1 execute wwb --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS work_interval (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- server-assigned; the ONLY pull watermark
  id              TEXT    NOT NULL UNIQUE,            -- UUIDv7, minted CLIENT-SIDE at interval close
  machine_id      TEXT    NOT NULL,                   -- IOPlatformUUID (ioreg, zero permissions)
  started_at_ms   INTEGER NOT NULL,                   -- epoch ms UTC; the FIRST real signal
  ended_at_ms     INTEGER NOT NULL,                   -- epoch ms UTC; the LAST REAL SIGNAL.
                                                      -- Never the timeout instant. Never now().
  duration_s      INTEGER NOT NULL,
  end_reason      TEXT    NOT NULL,                   -- idle_timeout | sleep | lock | shutdown
                                                      -- | app_quit | paused | crash_recovered | tap_lost
  tz              TEXT    NOT NULL,                   -- IANA zone at close, e.g. 'America/Chicago'
  local_date      TEXT    NOT NULL,                   -- 'YYYY-MM-DD' of started_at in tz, client-minted
  key_events      INTEGER NOT NULL DEFAULT 0,
  mouse_events    INTEGER NOT NULL DEFAULT 0,
  camera_s        INTEGER NOT NULL DEFAULT 0,         -- seconds of this interval with a camera in use
  jiggler_s       INTEGER NOT NULL DEFAULT 0,         -- seconds with OUR jiggler on — see PRD D1
  app_version     TEXT    NOT NULL,
  schema_v        INTEGER NOT NULL DEFAULT 1,
  closed_local_ms INTEGER NOT NULL,                   -- client wall clock at close; skew diagnosis
  server_ms       INTEGER NOT NULL                    -- Worker clock at insert
);
CREATE INDEX IF NOT EXISTS ix_wi_machine_start ON work_interval (machine_id, started_at_ms);
CREATE INDEX IF NOT EXISTS ix_wi_local_date    ON work_interval (local_date);

CREATE TABLE IF NOT EXISTS machine (
  machine_id   TEXT PRIMARY KEY,
  label        TEXT,                                  -- 'personal' | 'work' | anything
  os_version   TEXT,
  app_version  TEXT,
  last_seen_ms INTEGER NOT NULL
);

-- ═══ LOCAL MIRROR
--     ~/Library/Application Support/WorkWeekBuddy/local.db   (node:sqlite)
--     Same payload columns, plus sync bookkeeping.
CREATE TABLE IF NOT EXISTS work_interval ( /* …all payload columns above, id TEXT PRIMARY KEY… */
  cloud_seq    INTEGER,                               -- NULL until the cloud has it
  synced_at_ms INTEGER                                -- NULL = pending upload
);
CREATE INDEX IF NOT EXISTS ix_pending ON work_interval(ended_at_ms) WHERE synced_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS open_interval (            -- crash-safety journal, exactly one row
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT, machine_id TEXT, started_at_ms INTEGER, last_signal_ms INTEGER,
  key_events INTEGER, mouse_events INTEGER, camera_s INTEGER, jiggler_s INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT);
-- keys: 'pull_watermark', 'last_cloud_write_ms'
```

`local_date` is **stored and client-minted**, not generated: converting UTC to a per-row IANA zone is not an immutable expression, and storing it makes every heatmap query a plain `GROUP BY`.

## Why there are no conflicts

1. **Row ownership is total.** Every row carries `machine_id`, and a machine only ever inserts rows bearing its own token-stamped id. Two machines cannot address the same row.
2. **The primary key is client-minted at interval close**, before the first upload attempt, and persisted locally. The same UUIDv7 is reused on every retry forever.
3. **The table is append-only**, enforced by the Worker's route surface rather than by convention.
4. Therefore insert is commutative and idempotent — batch order, interleaving, partial application and replay are all safe.
5. The only shared row is the heartbeat, made commutative anyway:
   `ON CONFLICT(machine_id) DO UPDATE SET last_seen_ms = MAX(machine.last_seen_ms, excluded.last_seen_ms)`
   The machine's **label** lives on that row and nowhere else — never on `work_interval`. That is what makes renaming a Mac a one-row write that relabels its entire history at query time, rather than a backfill that can leave old rows disagreeing with new ones. The label follows the same `MAX(last_seen_ms)` rule, so a rename made offline outranks the older cloud row a later pull brings back.
6. **Clock skew produces no conflicts**, only UI ordering noise. `closed_local_ms` vs `server_ms` makes it diagnosable.

**Overlapping intervals across the two Macs are correct and expected** — typing on the work Mac while a meeting runs on the personal Mac. Summing them double-counts: measured 10% error on a three-interval case from a single 30-minute overlap. The metrics below handle this with an explicit union.

## Worker API

`https://wwb-sync.<subdomain>.workers.dev` — and, optionally, a second hostname
on a domain the owner already has. **Both reach the same script and the same
database**, and the Worker stamps `machine_id` from the credential rather than
from the host, so which address a request arrives on is invisible to everything
below. Nothing keyed to a URL exists: `pull_watermark`, `last_cloud_write_ms`,
`synced_at_ms` and the `machine_token` registry are all keyed to a `seq`, a
machine or a digest, which is why changing the address a Mac uses moves no data
and needs no migration.

| Route | Purpose |
|---|---|
| `POST /intervals` | `{machine_id, rows[]}` → `INSERT … ON CONFLICT(id) DO NOTHING` via `DB.batch()`; returns the ids now **present** |
| `GET /intervals?since=<seq>&limit=1000` | pull |
| `POST /heartbeat` | liveness, and the machine's own label |
| `GET /machines` | the read half of the heartbeat — how one Mac learns the other's name |
| `GET /fingerprint` | `{count, max_ended_at_ms, sha256(sorted ids)}` |

**No DELETE, no UPDATE, no arbitrary SQL, ever.** One bearer token per machine, resolved through the **`machine_token` registry**: the Worker hashes what was presented and looks the digest up, so nothing is hardcoded to a number of machines (`docs/PRD.md` §7). It stamps `machine_id` from that row — from the CREDENTIAL, never from the request body — so a stolen token cannot forge another machine's rows.

```sql
CREATE TABLE IF NOT EXISTS machine_token (
  token_sha256   TEXT    PRIMARY KEY,   -- lowercase hex SHA-256 of the bearer token
  machine_id     TEXT    NOT NULL,      -- IOPlatformUUID; stamped onto every row this token writes
  enrolled_at_ms INTEGER NOT NULL,
  revoked_at_ms  INTEGER                -- NULL = live
);
```

**Cloudflare never holds a token, only a digest.** The plaintext exists in that Mac's Keychain and nowhere else, so a dump of this database hands over nothing that can be presented as a credential.

**Nothing the Worker serves can write this table.** Enrolment and revocation are D1 REST writes made with the Cloudflare API token — the credential that can already delete everything. A stolen bearer token can append rows as itself and nothing more. Revoking a Mac is one `UPDATE`, effective on its next request; rows are never deleted, for the same reason `work_interval` rows are not.

There is deliberately **no `label` column** — same rule as `work_interval`. A machine's name lives on `machine`, written by that machine's heartbeat, and is `LEFT JOIN`ed at query time.

Client-side the token goes through Electron `safeStorage.encryptString`, which is backed by the macOS Keychain. Never a plist, never a dotfile, never the asar, never the repo.

## Metrics

Two views carry every policy knob, so the PRD's open decisions are query-time switches rather than migrations.

```sql
-- ── policy layer: the open decisions live here and nowhere else ───────────────
CREATE VIEW v_countable AS
SELECT *,
       CASE WHEN end_reason = 'idle_timeout' THEN :grace_s ELSE 0 END AS grace_s
FROM work_interval
WHERE duration_s >= :min_interval_s                    -- stray-bump floor, default 90
  AND (:count_jiggler_time = 1 OR jiggler_s = 0);      -- PRD D1. Default 0 = reading (a).

-- Why this filter is safe: toggling the jiggler CLOSES the current interval and opens
-- a new one, so every stored interval is homogeneous — jiggler_s is either 0 or equal
-- to duration_s, never in between. Partial coverage would not compose with the union
-- merge below, which works on timestamps and needs a single truthful start and end.

-- ── merge overlapping intervals ACROSS machines, per local day ───────────────
CREATE VIEW v_merged_day AS
WITH o AS (
  SELECT local_date, started_at_ms, ended_at_ms + grace_s*1000 AS ended_at_ms,
         MAX(ended_at_ms + grace_s*1000) OVER (
           PARTITION BY local_date ORDER BY started_at_ms
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
  FROM v_countable
), m AS (
  SELECT *, CASE WHEN prev_max IS NULL OR started_at_ms > prev_max THEN 1 ELSE 0 END AS is_start FROM o
), g AS (
  SELECT *, SUM(is_start) OVER (PARTITION BY local_date ORDER BY started_at_ms
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS island FROM m
)
SELECT local_date, island, MIN(started_at_ms) AS s_ms, MAX(ended_at_ms) AS e_ms
FROM g GROUP BY local_date, island;
```

```sql
-- 1) HOURS THIS WEEK (headline). Monday start, union across machines, so a day
--    cannot contain more than 24 hours of "was working".
WITH wk AS (SELECT date('now','localtime','-6 days','weekday 1') AS mon)
SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours_this_week
FROM v_merged_day, wk
WHERE local_date >= wk.mon AND local_date < date(wk.mon, '+7 days');

-- 1b) HOURS ON ONE LOCAL DAY. Query 1 with a day's bounds instead of a week's,
--     and it is the SAME union: a plain SUM(duration_s) double-counts the
--     stretch where both Macs were awake. This is the dashboard's "Today" card
--     and, through LiveStatus.closedHoursToday, the menu-bar title.
SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours
FROM v_merged_day WHERE local_date = :d;

-- 1c) THE WEEKLY STRIP — MetricsBundle.weekSeries, the sixteen bars under the
--     heatmap. Query 1 again, sixteen times, with each week's own bounds. There
--     is no new SQL and there is deliberately no new view.
--
--     DO NOT BUILD IT BY SUMMING QUERY 4. The heatmap is right there in the same
--     bundle and it looks like seven days of a week add up to the week, but it
--     rounds each DAY to 2dp where query 1 rounds the WEEK'S SUM: seven rounded
--     days land up to 0.035 h out, which is enough for the newest bar to print a
--     different tenth from the "This week" card on the same screen, with nothing
--     anywhere reporting an error.
--
--     The walk back is in CALENDAR weeks. k × 7 × 86_400_000 is seven 24-hour
--     days, and a DST transition inside the window slides every earlier anchor
--     by an hour — enough to drop a week from the middle of the strip while
--     still drawing sixteen bars. src/main/metrics.ts anchors midweek first.
--
--     A week before MIN(local_date) is NULL and is not drawn at all. A tracked
--     week with nothing countable in it is 0 and IS drawn. PRD §4.
SELECT ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS hours
FROM v_merged_day WHERE local_date >= :week_from AND local_date < :week_to;

-- 2) AVERAGE INTERVAL LENGTH — over raw intervals, NOT merged islands.
--    The interval is the unit; merging would blend two machines into one "interval".
WITH wk AS (SELECT date('now','localtime','-6 days','weekday 1') AS mon)
SELECT ROUND(AVG(duration_s + grace_s) / 60.0, 1) AS avg_interval_min,
       COUNT(*)                                    AS n_intervals
FROM v_countable, wk
WHERE local_date >= wk.mon AND local_date < date(wk.mon, '+7 days');

-- 3) LONGEST INTERVAL — two ways, because they answer different questions.
SELECT 'single_interval' AS kind, machine_id, local_date,
       ROUND(MAX(duration_s + grace_s)/3600.0, 2) AS hours
FROM v_countable
UNION ALL
SELECT 'merged_session', NULL, local_date, ROUND(MAX(e_ms - s_ms)/3600000.0, 2)
FROM v_merged_day GROUP BY local_date ORDER BY hours DESC LIMIT 1;

-- 4) PER-DAY HEATMAP. react-activity-calendar wants {date, count, level}.
--    371 days so the calendar always has a full year plus the partial week.
SELECT local_date AS date,
       ROUND(SUM(e_ms - s_ms) / 3600000.0, 2) AS count,
       MIN(4, CAST(SUM(e_ms - s_ms) / 3600000.0 / NULLIF(:level_step_h, 0) AS INTEGER)) AS level
FROM v_merged_day
WHERE local_date >= date('now','localtime','-371 days')
GROUP BY local_date ORDER BY local_date;

-- 5) PER-MACHINE BREAKDOWN. A plain SUM is correct here: one machine's own
--    intervals are disjoint by construction, so there is nothing to merge.
WITH wk AS (SELECT date('now','localtime','-6 days','weekday 1') AS mon)
SELECT m.label, i.machine_id,
       ROUND(SUM(i.duration_s + i.grace_s)/3600.0, 2) AS hours,
       COUNT(*)                                        AS intervals,
       ROUND(SUM(i.camera_s)/3600.0, 2)                AS meeting_hours,
       ROUND(SUM(i.jiggler_s)/3600.0, 2)               AS hours_with_jiggler_on
FROM v_countable i JOIN machine m USING (machine_id), wk
WHERE i.local_date >= wk.mon AND i.local_date < date(wk.mon,'+7 days')
GROUP BY i.machine_id ORDER BY hours DESC;

-- 6) The honesty widget: what the union actually saves. Show both, so overlap
--    between the two Macs is visible rather than hidden.
SELECT (SELECT SUM(duration_s + grace_s)/3600.0 FROM v_countable  WHERE local_date = :d) AS naive_sum_h,
       (SELECT SUM(e_ms - s_ms)/3600000.0       FROM v_merged_day WHERE local_date = :d) AS union_h;
```

**Documented simplification:** each interval is attributed wholly to the `local_date` of its `started_at_ms`, so a session crossing local midnight lands entirely on the earlier day. Deliberate — the unit is the *work session*. Splitting at midnight is a query-time variant (a recursive CTE) needing no schema change.

## Backups — four layers, zero commands to type

| Layer | What | Cost |
|---|---|---|
| **1. Two full local mirrors** | Each Mac holds the entire merged history. Falls out of the design for free and is the single biggest durability win. Total vendor loss ⇒ `UPDATE work_interval SET synced_at_ms = NULL` on either Mac and the flush loop rebuilds the cloud. | free |
| **2. Weekly self-export** | First launch each week, dump the merged mirror to iCloud Drive if present, else `~/Documents/WorkWeekBuddy/backups/`, as `wwb-YYYY-Www.sqlite` + `.ndjson.gz`. Keep 52. Time Machine and iCloud carry it off incidentally. **NDJSON deliberately, not a vendor dump** — it restores into any future backend, which is what makes vendor exit cheap. | ~1 MB/yr |
| **3. Weekly fingerprint check** | `GET /fingerprint` vs the same computed locally over synced rows. Mismatch ⇒ tray badge + log line. **This is the layer that catches *silent* loss** — without it, backups are theatre, because you never learn you needed them. Ship in v1. | ~0 |
| **4. Silence alarm** | `last_cloud_write_ms` older than 72 h ⇒ change the tray icon and post a notification. This is what catches a free-tier policy change in 2031, when nobody is reading email from Cloudflare. | ~0 |

Plus D1's own 7-day Time Travel for the "I ran a bad statement 20 minutes ago" case. **Layers 2 and 3 are load-bearing, not optional**, precisely because 7 days is short.

If vendor risk should ever be removed contractually rather than absorbed, Cloudflare Workers Paid is $5/mo and lifts Time Travel to 30 days. With layers 1–4 in place, $0 is the correct answer, because the failure mode has been converted from "lost data" into "sync backlog."
