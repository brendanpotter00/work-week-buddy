/**
 * A D1 double backed by `node:sqlite`.
 *
 * Cloudflare D1 *is* SQLite, which is most of why it was chosen — so the
 * honest way to test this Worker is to run its SQL, unmodified, against a real
 * SQLite of the same dialect. A hand-rolled in-memory map would happily accept
 * `ON CONFLICT(id) DO NOTHING`, `MAX(machine.last_seen_ms, excluded.…)` and a
 * 96-parameter multi-row VALUES without ever proving any of them parse.
 *
 * The schema comes from `worker/schema.sql`, the same file that is executed
 * against the real database, so the tests cannot drift from what is deployed.
 *
 * Two behaviours are modelled deliberately because the code under test depends
 * on them:
 *
 *   • `batch()` is ONE transaction — all statements commit or none do.
 *   • every `bind()` is recorded, so the 100-bound-parameter cap is an
 *     assertion over what the Worker actually sent, not a re-derivation of the
 *     arithmetic the Worker used.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../src/types.js";

const SCHEMA = readFileSync(
  fileURLToPath(new URL("../schema.sql", import.meta.url)),
  "utf8",
);

/** D1's documented bound-parameter ceiling per statement. */
export const D1_BOUND_PARAM_LIMIT = 100;

export interface BoundStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * D1 accepts booleans and coerces them to 0/1; `node:sqlite` throws on them.
 * Coerce here so the fake is permissive in exactly the way D1 is, and no more.
 */
function toSqlite(v: unknown): SqliteValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "string" ||
    v instanceof Uint8Array
  ) {
    return v;
  }
  throw new TypeError(
    `D1 cannot bind a value of type ${typeof v}: ${String(v)}`,
  );
}

/** node:sqlite hands back null-prototype rows; D1 hands back plain objects. */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

class FakeStatement implements D1PreparedStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const next = new FakeStatement(this.db, this.sql, values);
    this.db.recordBind({ sql: this.sql, params: values });
    return next;
  }

  private prepared() {
    return this.db.raw.prepare(this.sql);
  }

  private args(): SqliteValue[] {
    return this.params.map(toSqlite);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.prepared().all(...this.args());
    return { results: rows.map((r) => plain<T>(r)), success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.prepared().get(...this.args());
    return row === undefined ? null : plain<T>(row);
  }

  async run(): Promise<D1Result<never>> {
    this.prepared().run(...this.args());
    return { results: [], success: true };
  }

  /** Used only by `batch`, which must run everything inside one transaction. */
  runSync(): void {
    this.prepared().run(...this.args());
  }
}

export class FakeD1 implements D1Database {
  readonly raw: DatabaseSync;
  /** Every bind the Worker issued, in order. The cap assertion reads this. */
  readonly binds: BoundStatement[] = [];
  /** How many `batch()` calls were made — chunking is visible here. */
  batchCount = 0;

  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(SCHEMA);
  }

  recordBind(b: BoundStatement): void {
    this.binds.push(b);
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.batchCount++;
    this.raw.exec("BEGIN");
    try {
      for (const s of statements) (s as FakeStatement).runSync();
      this.raw.exec("COMMIT");
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
    return statements.map(() => ({ results: [] as T[], success: true }));
  }

  // ── test conveniences ─────────────────────────────────────────────────────

  /** The largest number of parameters bound to any single statement so far. */
  maxBoundParams(): number {
    return this.binds.reduce((m, b) => Math.max(m, b.params.length), 0);
  }

  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw
      .prepare(sql)
      .all(...params.map(toSqlite))
      .map((r) => plain<T>(r));
  }

  count(table: "work_interval" | "machine" | "machine_token"): number {
    const r = this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return r.n;
  }

  close(): void {
    this.raw.close();
  }
}
