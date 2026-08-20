import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDb, migrate, SCHEMA_VERSION } from "../../src/store/db";
import { PAYLOAD_COLUMNS } from "../../src/store/schema";
import { openTestDb, tmpDbPath } from "../fakes/seed-db";

function names(db: DatabaseSync, type: string): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((r) => String((r as Record<string, unknown>)["name"]));
}

describe("schema", () => {
  it("creates every table, index and view on an empty file", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const db = openDb(path);
      expect(names(db, "table")).toEqual(
        expect.arrayContaining(["work_interval", "machine", "open_interval", "sync_state"]),
      );
      expect(names(db, "index")).toEqual(
        expect.arrayContaining(["ix_wi_machine_start", "ix_wi_local_date", "ix_pending"]),
      );
      expect(names(db, "view")).toEqual(["v_countable", "v_merged_day"]);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("stamps user_version and is idempotent", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const first = openDb(path);
      const v = first.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(v.user_version).toBe(SCHEMA_VERSION);
      first.close();

      // Reopening runs migrate() again over a populated file. Forward-only and
      // idempotent means this is a no-op, not a second CREATE.
      const second = openDb(path);
      migrate(second);
      migrate(second);
      const v2 = second.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(v2.user_version).toBe(SCHEMA_VERSION);
      expect(names(second, "view")).toEqual(["v_countable", "v_merged_day"]);
      second.close();
    } finally {
      cleanup();
    }
  });

  it("keeps the CHECK that makes the close rule structural", () => {
    const db = openTestDb();
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'work_interval'")
      .get() as { sql: string };
    expect(ddl.sql.replace(/\s+/g, " ")).toContain("CHECK (ended_at_ms = last_signal_at_ms)");
  });

  it("carries every payload column the Worker inserts", () => {
    const db = openTestDb();
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('work_interval')")
      .all()
      .map((r) => String((r as Record<string, unknown>)["name"]));
    for (const c of PAYLOAD_COLUMNS) expect(cols).toContain(c);
    // Plus the local-only bookkeeping. The mirror IS the outbox: there is no
    // second queue table anywhere in this schema.
    expect(cols).toContain("cloud_seq");
    expect(cols).toContain("synced_at_ms");
    expect(names(db, "table")).not.toContain("outbox");
    expect(names(db, "table")).not.toContain("upload_queue");
  });

  it("keeps the journal to a single row by construction", () => {
    const db = openTestDb();
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'open_interval'")
      .get() as { sql: string };
    expect(ddl.sql.replace(/\s+/g, " ")).toContain("CHECK (singleton = 1)");
    expect(() =>
      db.prepare("INSERT INTO open_interval (singleton) VALUES (2)").run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
