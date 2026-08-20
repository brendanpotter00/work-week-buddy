/**
 * A cloud you can break on purpose.
 *
 * This is not a mock of the Worker — it *is* the Worker
 * (`worker/src/index.ts`), served over `worker/test/fake-d1.ts`, a `node:sqlite`
 * D1 double running the deployed `worker/schema.sql`. `createWorkerClient` is
 * handed this object's `fetch`, so every sync test exercises the real routes,
 * the real presence read-back, the real machine-id stamping and the real
 * bound-parameter chunking, in D1's own SQL dialect.
 *
 * What is faked is only the network, and only in the four ways that matter:
 *
 *   offline            the fetch rejects — which IS the network signal
 *   dropResponses      the Worker runs and COMMITS, then the response is lost
 *   failWithStatus     a non-2xx arrives instead of a body
 *   hiddenSeqs         a committed row is not yet visible to a range read,
 *                      which is how AUTOINCREMENT identities really behave
 *
 * The tokens are obvious nonsense, deliberately. AGENTS.md: the real token
 * never appears in a fixture or a commit.
 */
import worker from "../../worker/src/index.js";
import { FakeD1 } from "../../worker/test/fake-d1.js";
import type { Env } from "../../worker/src/types.js";

export const TOKEN_PERSONAL = "not-a-real-token-personal-aaaaaaaaaaaaaaaa";
export const TOKEN_WORK = "not-a-real-token-work-bbbbbbbbbbbbbbbbbbbb";
export const MACHINE_PERSONAL = "00000000-0000-0000-0000-00000000AAAA";
export const MACHINE_WORK = "00000000-0000-0000-0000-00000000BBBB";

export const BASE_URL = "https://wwb-sync.test";

export interface CloudCall {
  readonly method: string;
  readonly path: string;
  /** `since` on a range read, so the 200-row overlap is directly assertable. */
  readonly since: number | null;
  readonly limit: number | null;
  /** Rows in the body of a POST /intervals, else 0. */
  readonly rows: number;
  readonly outcome: "answered" | "offline" | "dropped" | "failed";
}

export interface CloudRowRecord {
  readonly seq: number;
  readonly id: string;
  readonly machine_id: string;
  readonly ended_at_ms: number;
}

export class FakeCloud {
  readonly d1 = new FakeD1();
  readonly env: Env;
  readonly calls: CloudCall[] = [];

  /** The fetch rejects before the Worker is reached. Airplane mode. */
  offline = false;
  /** Run the Worker, commit, then lose the response this many more times. */
  dropResponses = 0;
  /** Answer with this status instead of reaching the Worker. */
  failWithStatus: number | null = null;
  /** Committed rows a range read cannot see yet — out-of-order visibility. */
  readonly hiddenSeqs = new Set<number>();

  constructor() {
    this.env = {
      DB: this.d1,
      TOKEN_PERSONAL,
      TOKEN_WORK,
      MACHINE_ID_PERSONAL: MACHINE_PERSONAL,
      MACHINE_ID_WORK: MACHINE_WORK,
    };
  }

  /** Hand this to `createWorkerClient({ fetchImpl })`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const path = url.pathname;
    const rows = await countRows(req);
    const record = (outcome: CloudCall["outcome"]): void => {
      this.calls.push({
        method: req.method,
        path,
        since: numParam(url, "since"),
        limit: numParam(url, "limit"),
        rows,
        outcome,
      });
    };

    if (this.offline) {
      record("offline");
      // Exactly what undici throws with no route to the host.
      throw new TypeError("fetch failed");
    }

    if (this.failWithStatus !== null) {
      record("failed");
      return new Response("nope", { status: this.failWithStatus });
    }

    const res = await worker.fetch(req, this.env);

    if (this.dropResponses > 0) {
      this.dropResponses--;
      // The server has already committed. The client never learns the answer —
      // the single most dangerous moment in the whole sync path.
      record("dropped");
      throw new TypeError("fetch failed");
    }

    record("answered");
    return this.hiddenSeqs.size > 0 && req.method === "GET" && path === "/intervals"
      ? await hideSeqs(res, this.hiddenSeqs)
      : res;
  };

  rows(): CloudRowRecord[] {
    return this.d1.query<CloudRowRecord>(
      "SELECT seq, id, machine_id, ended_at_ms FROM work_interval ORDER BY seq",
    );
  }

  ids(): string[] {
    return this.d1
      .query<{ id: string }>("SELECT id FROM work_interval ORDER BY id")
      .map((r) => r.id);
  }

  count(): number {
    return this.d1.count("work_interval");
  }

  /** Total vendor loss, simulated. `docs/IMPL_STORE_SYNC.md` §8, layer 1. */
  wipe(): void {
    this.d1.raw.exec("DELETE FROM work_interval");
  }

  postCount(): number {
    return this.calls.filter((c) => c.method === "POST" && c.path === "/intervals").length;
  }

  /** Every `since` a range read asked for, in order. The overlap shows here. */
  pullSince(): number[] {
    return this.calls
      .filter((c) => c.method === "GET" && c.path === "/intervals")
      .map((c) => c.since ?? -1);
  }
}

function numParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  return raw === null ? null : Number(raw);
}

async function countRows(req: Request): Promise<number> {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/intervals") return 0;
  try {
    const body = (await req.clone().json()) as { rows?: unknown[] };
    return Array.isArray(body.rows) ? body.rows.length : 0;
  } catch {
    return 0;
  }
}

/** Drop rows the reader "cannot see yet", preserving everything else. */
async function hideSeqs(res: Response, hidden: ReadonlySet<number>): Promise<Response> {
  const body = (await res.json()) as { rows: Array<{ seq: number }> };
  return Response.json({ rows: body.rows.filter((r) => !hidden.has(r.seq)) });
}
