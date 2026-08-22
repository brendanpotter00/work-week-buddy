/**
 * Shared fixtures for the Worker tests.
 *
 * The token literals below are obvious nonsense on purpose. AGENTS.md is
 * explicit that the real database token never appears in a plist, a dotfile,
 * the asar, a test fixture or a commit — it is minted by the app, goes straight
 * into the macOS Keychain, and only its SHA-256 ever leaves the Mac. These
 * strings exist only so the registry has distinguishable rows.
 *
 * ── Why the seed hashes with `node:crypto` ──────────────────────────────────
 * The Worker hashes the presented token with WebCrypto; the app enrols using
 * `node:crypto`. If those two ever disagreed, every machine would 401 forever
 * with nothing in any log. Seeding the registry here with `node:crypto` while
 * the Worker looks rows up with WebCrypto makes EVERY test in this directory a
 * cross-implementation agreement check — a test that fails loudly instead of a
 * property nobody re-verifies. auth.test.ts also pins it directly.
 */

import { createHash } from "node:crypto";
import worker from "../src/index.js";
import { FakeD1 } from "./fake-d1.js";
import type { Env } from "../src/types.js";

export const TOKEN_A = "not-a-real-token-machine-a-aaaaaaaaaaaaaaaa";
export const TOKEN_B = "not-a-real-token-machine-b-bbbbbbbbbbbbbbbb";

/** Stand-ins for two Macs' IOPlatformUUIDs. */
export const MACHINE_A = "00000000-0000-0000-0000-00000000AAAA";
export const MACHINE_B = "00000000-0000-0000-0000-00000000BBBB";

/** SHA-256, lowercase hex — the format `machine_token.token_sha256` stores. */
export function sha256HexNode(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface Enrolment {
  readonly token: string;
  readonly machineId: string;
  readonly revoked?: boolean;
}

export interface HarnessOptions {
  /**
   * Defaults to two live rows, one per machine. Two is not a limit any more —
   * it is just the smallest number that can prove one token cannot stamp the
   * other's id. Pass `[]` for an unenrolled deployment, or a longer list.
   */
  readonly enrolled?: readonly Enrolment[];
  /** Drop the registry table, to model a Worker deployed without its schema. */
  readonly noRegistry?: boolean;
}

export interface Harness {
  readonly db: FakeD1;
  readonly env: Env;
}

export function harness(opts: HarnessOptions = {}): Harness {
  const db = new FakeD1();
  const enrolled = opts.enrolled ?? [
    { token: TOKEN_A, machineId: MACHINE_A },
    { token: TOKEN_B, machineId: MACHINE_B },
  ];

  if (opts.noRegistry === true) {
    db.raw.exec("DROP TABLE machine_token");
  } else {
    for (const e of enrolled) {
      db.raw
        .prepare(
          `INSERT INTO machine_token
             (token_sha256, machine_id, enrolled_at_ms, revoked_at_ms)
           VALUES (?,?,?,?)`,
        )
        .run(
          sha256HexNode(e.token),
          e.machineId,
          1_760_000_000_000,
          e.revoked === true ? 1_760_000_001_000 : null,
        );
    }
  }

  return { db, env: { DB: db } };
}

export interface CallOptions {
  readonly method: string;
  readonly path: string;
  /** Omit for an anonymous request. */
  readonly token?: string;
  readonly body?: unknown;
  /** Send a raw string body — for the malformed-JSON cases. */
  readonly rawBody?: string;
}

export async function call(env: Env, opts: CallOptions): Promise<Response> {
  const headers = new Headers();
  if (opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  const init: RequestInit = { method: opts.method, headers };
  if (opts.rawBody !== undefined) {
    headers.set("content-type", "application/json");
    init.body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(opts.body);
  }
  const req = new Request(`https://wwb-sync.test${opts.path}`, init);
  return worker.fetch(req, env);
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface PresentRow {
  readonly id: string;
  readonly seq: number;
}
export interface PostResponse {
  readonly present: PresentRow[];
  readonly server_ms: number;
}

/** A complete wire row. Every NOT NULL column the client is expected to send. */
export function makeRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const startedAtMs = 1_760_000_000_000;
  return {
    id,
    // Deliberately present, and deliberately wrong. Every test that posts a row
    // is therefore also a test that the body cannot forge machine_id.
    machine_id: "forged-by-the-client",
    started_at_ms: startedAtMs,
    ended_at_ms: startedAtMs + 600_000,
    duration_s: 600,
    end_reason: "idle_timeout",
    tz: "America/Chicago",
    local_date: "2025-10-09",
    key_events: 120,
    mouse_events: 45,
    camera_s: 0,
    jiggler_s: 0,
    app_version: "0.1.0",
    schema_v: 1,
    closed_local_ms: startedAtMs + 600_000,
    server_ms: 1, // also stamped by the Worker; a client value here is ignored
    ...overrides,
  };
}

/** `n` distinct rows with sortable, stable ids. */
export function makeRows(n: number, prefix = "row"): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow(`${prefix}-${String(i).padStart(4, "0")}`),
  );
}
