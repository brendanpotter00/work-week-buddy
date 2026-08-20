-- The cloud half of docs/DATA_MODEL.md, verbatim.
--
--   wrangler d1 execute wwb --remote --file=worker/schema.sql
--
-- This file is also what worker/test/fake-d1.ts loads, so the tests run against
-- the schema that is actually deployed rather than a hand-copied paraphrase of
-- it. If the two ever drift, the tests are testing a fiction.

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
  label        TEXT,
  os_version   TEXT,
  app_version  TEXT,
  last_seen_ms INTEGER NOT NULL
);
