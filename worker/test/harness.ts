/**
 * Shared fixtures for the Worker tests.
 *
 * The token literals below are obvious nonsense on purpose. AGENTS.md is
 * explicit that the real database token never appears in a plist, a dotfile,
 * the asar, a test fixture or a commit — it goes from `openssl rand` straight
 * into `wrangler secret put` and the macOS Keychain. These strings exist only
 * so the comparison has two distinguishable inputs.
 */

import worker from "../src/index.js";
import { FakeD1 } from "./fake-d1.js";
import type { Env } from "../src/types.js";

export const TOKEN_PERSONAL = "not-a-real-token-personal-aaaaaaaaaaaaaaaa";
export const TOKEN_WORK = "not-a-real-token-work-bbbbbbbbbbbbbbbbbbbb";

/** Stand-ins for the two Macs' IOPlatformUUIDs. */
export const MACHINE_PERSONAL = "00000000-0000-0000-0000-00000000AAAA";
export const MACHINE_WORK = "00000000-0000-0000-0000-00000000BBBB";

export interface Harness {
  readonly db: FakeD1;
  readonly env: Env;
}

export function harness(overrides: Partial<Env> = {}): Harness {
  const db = new FakeD1();
  const env: Env = {
    DB: db,
    TOKEN_PERSONAL,
    TOKEN_WORK,
    MACHINE_ID_PERSONAL: MACHINE_PERSONAL,
    MACHINE_ID_WORK: MACHINE_WORK,
    ...overrides,
  };
  return { db, env };
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
