/**
 * The local mirror's schema. The local half of `docs/DATA_MODEL.md`, plus the
 * sync bookkeeping columns and the one CHECK constraint that turns the close
 * rule into a structural fact.
 *
 * Two stores, one dialect: D1 *is* SQLite, so these payload columns are the
 * same columns the Worker inserts, in the same order, and the metric queries
 * run unchanged against either.
 */

/**
 * THE constraint. `docs/IMPL_STORE_SYNC.md` §1:
 *
 *   "An agent that later writes `ended_at = now()` gets a loud constraint
 *    violation instead of silently inflating every number in the product."
 *
 * `last_signal_at_ms` is not in the column list in `docs/DATA_MODEL.md`, but
 * the CHECK the plan mandates references it, so the column has to exist. It
 * carries the same value as `ended_at_ms` by definition — that redundancy is
 * the point. It is the assertion, written down in the file format.
 */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS work_interval (
  id              TEXT    PRIMARY KEY,          -- UUIDv7, minted CLIENT-SIDE at interval close
  machine_id      TEXT    NOT NULL,             -- IOPlatformUUID
  started_at_ms   INTEGER NOT NULL,             -- epoch ms UTC; the FIRST real signal
  ended_at_ms     INTEGER NOT NULL,             -- epoch ms UTC; the LAST REAL SIGNAL.
                                                -- Never the timeout instant. Never now().
  last_signal_at_ms INTEGER NOT NULL,           -- the same value, kept so the CHECK below can exist
  duration_s      INTEGER NOT NULL,
  end_reason      TEXT    NOT NULL,
  tz              TEXT    NOT NULL,             -- IANA zone at close
  local_date      TEXT    NOT NULL,             -- 'YYYY-MM-DD' of started_at in tz, client-minted
  key_events      INTEGER NOT NULL DEFAULT 0,
  mouse_events    INTEGER NOT NULL DEFAULT 0,
  camera_s        INTEGER NOT NULL DEFAULT 0,
  jiggler_s       INTEGER NOT NULL DEFAULT 0,
  app_version     TEXT    NOT NULL,
  schema_v        INTEGER NOT NULL DEFAULT 1,
  closed_local_ms INTEGER NOT NULL,             -- client wall clock at close; skew diagnosis
  server_ms       INTEGER,                      -- NULL until the cloud has stamped it
  cloud_seq       INTEGER,                      -- NULL until the cloud has it
  synced_at_ms    INTEGER,                      -- NULL = pending upload. The mirror IS the outbox.
  CHECK (ended_at_ms = last_signal_at_ms)
);
CREATE INDEX IF NOT EXISTS ix_wi_machine_start ON work_interval (machine_id, started_at_ms);
CREATE INDEX IF NOT EXISTS ix_wi_local_date    ON work_interval (local_date);
CREATE INDEX IF NOT EXISTS ix_pending          ON work_interval (ended_at_ms) WHERE synced_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS machine (
  machine_id   TEXT PRIMARY KEY,
  label        TEXT,
  os_version   TEXT,
  app_version  TEXT,
  last_seen_ms INTEGER NOT NULL
);

-- The crash-safety journal: exactly one row, ever.
CREATE TABLE IF NOT EXISTS open_interval (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT, machine_id TEXT, started_at_ms INTEGER, last_signal_ms INTEGER,
  key_events INTEGER, mouse_events INTEGER, camera_s INTEGER, jiggler_s INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT);
`;

/** Every payload column, in the order the Worker's `COLS` expects them. */
export const PAYLOAD_COLUMNS = [
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
