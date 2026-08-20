/**
 * The Worker HTTP client — the only module in the app that knows a URL.
 *
 * Typed against `worker/src/routes.ts` as committed, not against the sketch in
 * `docs/IMPL_STORE_SYNC.md` §5. Two differences, both because the committed
 * Worker wins:
 *
 *   • `postIntervals` takes no `machineId`. The plan's sketch passes one, but
 *     the Worker derives the machine from the bearer token and discards
 *     whatever the body claims (`worker/src/routes.ts`, the forgery guard). A
 *     parameter the server ignores is a lie in a signature, so it is gone.
 *
 *   • Every non-2xx **throws** `HttpError` rather than returning `{ok:false}`.
 *     AGENTS.md #8 says a row may be marked synced only on presence in a 200
 *     response. Making a failure unrepresentable as a value means there is no
 *     branch anywhere in `flush.ts` that could reach `markSynced` without a
 *     parsed 200 body — the rule is enforced by control flow rather than by a
 *     conditional somebody could later invert.
 *
 * A failed fetch is left to reject as it is. It IS the network signal: there is
 * no reachability probe, no `navigator.onLine`, no ping. See `flush.ts`.
 */
import type { CloudPayload, IntervalRow } from "../store/intervals";
import { fromCloudRow, toWireRow } from "./wire";

/**
 * The Worker refuses more than 200 rows in one request
 * (`MAX_ROWS_PER_REQUEST`), which is exactly one drained page of the outbox.
 */
export const MAX_ROWS_PER_REQUEST = 200;

/** The Worker clamps `limit` to this. */
export const MAX_PULL_LIMIT = 1000;

const DEFAULT_TIMEOUT_MS = 20_000;

/** One row the server can SEE. `seq` is what the client stores as `cloud_seq`. */
export interface PresentRow {
  readonly id: string;
  readonly seq: number;
}

export interface PostResult {
  /** The read-back, not the insert count. The only thing that may mark a row. */
  readonly present: PresentRow[];
  readonly serverMs: number;
}

export interface PullPage {
  readonly rows: CloudPayload[];
}

export interface CloudFingerprint {
  readonly count: number;
  readonly maxEndedAtMs: number;
  /** Lowercase hex SHA-256 over `ids.sort().join("\n")`. See `fingerprint.ts`. */
  readonly sha256: string;
}

export interface HeartbeatInfo {
  readonly label?: string;
  readonly osVersion?: string;
  readonly appVersion?: string;
}

export interface WorkerClient {
  /** POST /intervals. Throws on anything but 200. */
  postIntervals(rows: readonly IntervalRow[]): Promise<PostResult>;
  /** GET /intervals?since=&limit= — a plain range read; the overlap is ours. */
  getIntervals(since: number, limit?: number): Promise<PullPage>;
  /** POST /heartbeat. Liveness only; it moves no interval. */
  heartbeat(info?: HeartbeatInfo): Promise<void>;
  /** GET /fingerprint — the reconciliation target. */
  fingerprint(): Promise<CloudFingerprint>;
  /** GET /health — unauthenticated, for bring-up on the work Mac's proxy. */
  health(): Promise<{ ok: boolean; ms: number }>;
}

export interface WorkerClientConfig {
  /** e.g. `https://wwb-sync.<account>.workers.dev`. */
  readonly baseUrl: string;
  /**
   * The per-machine bearer token. It reaches this object from Electron
   * `safeStorage`, which is backed by the Keychain — never a plist, never a
   * dotfile, never the asar, never a fixture, never a commit.
   */
  readonly token: string;
  /** Injected by the tests, which route requests straight into the Worker. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A response arrived and it was not a 2xx. Never retried inside the client. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} → ${status}${body ? `: ${truncate(body)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export function createWorkerClient(cfg: WorkerClientConfig): WorkerClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {},
  ): Promise<unknown> {
    const headers = new Headers();
    if (opts.auth !== false) headers.set("authorization", `Bearer ${cfg.token}`);
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(opts.body);
    }
    // A hung socket must not wedge the drain loop: without a deadline the
    // single-flight guard would stay closed forever and the outbox would never
    // move again. An abort rejects, which is the same network signal as any
    // other failed fetch.
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    const res = await doFetch(`${base}${path}`, init);
    if (!res.ok) {
      throw new HttpError(method, path, res.status, await safeText(res));
    }
    return (await res.json()) as unknown;
  }

  return {
    async postIntervals(rows) {
      if (rows.length > MAX_ROWS_PER_REQUEST) {
        // The Worker answers 413 here. Failing on this side names the caller
        // instead of the server, and it can only be a programmer error:
        // `flush()` pages at exactly this number.
        throw new RangeError(
          `postIntervals: ${rows.length} rows exceeds the ${MAX_ROWS_PER_REQUEST}-row cap`,
        );
      }
      const body = await request("POST", "/intervals", {
        body: { rows: rows.map(toWireRow) },
      });
      return parsePost(body);
    },

    async getIntervals(since, limit = MAX_PULL_LIMIT) {
      const q = `?since=${String(Math.max(0, Math.trunc(since)))}&limit=${String(
        Math.min(Math.max(1, Math.trunc(limit)), MAX_PULL_LIMIT),
      )}`;
      const body = await request("GET", `/intervals${q}`);
      return { rows: asArray(body, "rows").map(fromCloudRow) };
    },

    async heartbeat(info = {}) {
      await request("POST", "/heartbeat", { body: info });
    },

    async fingerprint() {
      const body = await request("GET", "/fingerprint");
      const o = asObject(body, "fingerprint");
      return {
        count: numberField(o, "count"),
        maxEndedAtMs: numberField(o, "maxEndedAtMs"),
        sha256: stringField(o, "sha256"),
      };
    },

    async health() {
      const o = asObject(await request("GET", "/health", { auth: false }), "health");
      return { ok: o["ok"] === true, ms: numberField(o, "ms") };
    },
  };
}

/**
 * The presence answer, validated field by field.
 *
 * This is the single most dangerous parse in the app: a row marked from a
 * malformed answer is a row deleted from the outbox that never reached the
 * cloud, and nothing would ever report it. Anything unexpected throws, which
 * leaves every row pending and retried.
 */
function parsePost(body: unknown): PostResult {
  const o = asObject(body, "post response");
  const present = asArray(o, "present").map((raw, i) => {
    const row = asObject(raw, `present[${String(i)}]`);
    const id = stringField(row, "id");
    if (id === "") throw new Error(`present[${String(i)}]: empty id`);
    return { id, seq: numberField(row, "seq") };
  });
  const serverMs = o["server_ms"];
  return {
    present,
    serverMs: typeof serverMs === "number" ? serverMs : Date.now(),
  };
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${what}: expected an object, got ${String(v)}`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, key: string): unknown[] {
  const source = Array.isArray(v) ? v : asObject(v, key)[key];
  if (!Array.isArray(source)) throw new Error(`${key}: expected an array`);
  return source;
}

function numberField(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${key}: expected a number, got ${String(v)}`);
  }
  return v;
}

function stringField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") {
    throw new Error(`${key}: expected text, got ${String(v)}`);
  }
  return v;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
