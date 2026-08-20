/**
 * Opening the local mirror.
 *
 * `node:sqlite` ships inside Node 22.14.0 and inside Electron's own Node, so
 * there is no native module to rebuild, no `better-sqlite3`, and no ABI to
 * match. On Node 22.14.0 it needs no flag — it loads and prints one
 * `ExperimentalWarning`.
 *
 * No electron import lives in this file. `docs/IMPL_STORE_SYNC.md` §1 sketches
 * `app.getPath("userData")` here, but `docs/IMPL_LAYOUT.md` §1 forbids electron
 * imports anywhere under `src/store/`, and the second rule is the one that
 * keeps the whole store testable in a plain Node process. The caller in
 * `src/main/` passes the directory in.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DEFAULT_POLICY, MERGED_DAY_SQL, countableSql, type Policy } from "./policy";
import { SCHEMA_V1 } from "./schema";

/** Forward-only. Each step is idempotent. Never a rename. */
const STEPS: ReadonlyArray<(db: DatabaseSync) => void> = [(db) => db.exec(SCHEMA_V1)];

export const SCHEMA_VERSION = STEPS.length;

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const cur = row?.user_version ?? 0;
  for (let v = cur; v < STEPS.length; v++) {
    db.exec("BEGIN");
    try {
      STEPS[v]!(db);
      // PRAGMA does not accept bind parameters; v is a loop index over a
      // compile-time constant array, so there is no input to interpolate.
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/**
 * The two policy views, rebuilt from `policy.ts` on every open. A view is a
 * derived artifact, not data — recreating it is how the baked-in literals stay
 * in step with the compiled policy without a migration.
 */
export function applyViews(db: DatabaseSync, policy: Policy = DEFAULT_POLICY): void {
  db.exec(`
    DROP VIEW IF EXISTS v_merged_day;
    DROP VIEW IF EXISTS v_countable;
    CREATE VIEW v_countable  AS ${countableSql(policy)};
    CREATE VIEW v_merged_day AS ${MERGED_DAY_SQL};
  `);
}

export function openDb(path: string, policy: Policy = DEFAULT_POLICY): DatabaseSync {
  const db = new DatabaseSync(path);
  // synchronous = FULL, not NORMAL. `docs/IMPL_TASKS_EXPANDED.md` §T3.1 is
  // explicit and it outranks the NORMAL in `docs/IMPL_STORE_SYNC.md` §1: the
  // entire purpose of the journal is surviving `kill -9`, and NORMAL can lose
  // the last write — which is precisely the write that says where the interval
  // must be truncated.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  applyViews(db, policy);
  return db;
}

/** `~/Library/Application Support/WorkWeekBuddy/db/local.db` in production. */
export function defaultDbPath(userDataDir: string): string {
  const dir = join(userDataDir, "db");
  mkdirSync(dir, { recursive: true });
  return join(dir, "local.db");
}
