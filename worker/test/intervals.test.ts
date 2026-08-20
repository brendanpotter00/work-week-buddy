import { describe, it, expect } from "vitest";
import {
  COLS,
  D1_MAX_BOUND_PARAMS,
  MAX_ROWS_PER_REQUEST,
  ROWS_PER_STMT,
} from "../src/routes.js";
import { D1_BOUND_PARAM_LIMIT } from "./fake-d1.js";
import {
  call,
  harness,
  json,
  makeRow,
  makeRows,
  MACHINE_PERSONAL,
  MACHINE_WORK,
  TOKEN_PERSONAL,
  TOKEN_WORK,
  type PostResponse,
} from "./harness.js";

async function post(
  env: Parameters<typeof call>[0],
  rows: unknown[],
  token = TOKEN_PERSONAL,
): Promise<Response> {
  return call(env, { method: "POST", path: "/intervals", token, body: { rows } });
}

describe("POST /intervals — machine_id is stamped, never trusted", () => {
  it("ignores a body that claims the other machine's id", async () => {
    const { env, db } = harness();
    // The token is personal. The body insists the row belongs to the work Mac.
    const res = await post(
      env,
      [makeRow("forgery", { machine_id: MACHINE_WORK })],
      TOKEN_PERSONAL,
    );
    expect(res.status).toBe(200);

    const stored = db.query<{ id: string; machine_id: string }>(
      "SELECT id, machine_id FROM work_interval",
    );
    expect(stored).toEqual([{ id: "forgery", machine_id: MACHINE_PERSONAL }]);
    // And the forged value is nowhere in the table at all.
    expect(
      db.query("SELECT 1 FROM work_interval WHERE machine_id = ?", MACHINE_WORK),
    ).toEqual([]);
  });

  it("stamps every row in a mixed batch, not just the first", async () => {
    const { env, db } = harness();
    await post(
      env,
      [
        makeRow("a", { machine_id: MACHINE_PERSONAL }),
        makeRow("b", { machine_id: "somebody-else" }),
        makeRow("c", { machine_id: "" }),
      ],
      TOKEN_WORK,
    );
    expect(
      db.query<{ machine_id: string }>(
        "SELECT DISTINCT machine_id FROM work_interval",
      ),
    ).toEqual([{ machine_id: MACHINE_WORK }]);
  });

  it("stamps server_ms from the Worker clock, ignoring the client's value", async () => {
    const { env, db } = harness();
    const before = Date.now();
    await post(env, [makeRow("clock", { server_ms: 1 })]);
    const [stored] = db.query<{ server_ms: number; closed_local_ms: number }>(
      "SELECT server_ms, closed_local_ms FROM work_interval",
    );
    expect(stored!.server_ms).toBeGreaterThanOrEqual(before);
    // closed_local_ms is the CLIENT's clock and is preserved verbatim — the
    // pair is what makes skew diagnosable.
    expect(stored!.closed_local_ms).toBe(makeRow("clock")["closed_local_ms"]);
  });
});

describe("POST /intervals — idempotence", () => {
  it("inserting the same id twice yields one row, and BOTH responses report it present", async () => {
    const { env, db } = harness();
    const rows = [makeRow("dup-1"), makeRow("dup-2")];

    const first = await post(env, rows);
    const second = await post(env, rows);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.count("work_interval")).toBe(2);

    const a = await json<PostResponse>(first);
    const b = await json<PostResponse>(second);
    const ids = (r: PostResponse) => r.present.map((p) => p.id).sort();
    expect(ids(a)).toEqual(["dup-1", "dup-2"]);
    // ── AGENTS.md #8. This is the whole point: a response lost after the
    //    commit means the client replays, the upsert changes nothing, and the
    //    second answer STILL reports presence — so the rows get marked instead
    //    of being uploaded forever.
    expect(ids(b)).toEqual(["dup-1", "dup-2"]);
    // Same seq both times: the replay did not mint new rows.
    expect(b.present).toEqual(a.present);
  });

  it("a replay does not overwrite the row it already stored", async () => {
    const { env, db } = harness();
    await post(env, [makeRow("stable", { duration_s: 600 })]);
    await post(env, [makeRow("stable", { duration_s: 999_999 })]);
    expect(
      db.query<{ duration_s: number }>(
        "SELECT duration_s FROM work_interval WHERE id = 'stable'",
      ),
    ).toEqual([{ duration_s: 600 }]);
  });

  it("a duplicate id WITHIN one batch inserts once", async () => {
    const { env, db } = harness();
    const res = await post(env, [
      makeRow("same"),
      makeRow("same"),
      makeRow("other"),
    ]);
    expect(res.status).toBe(200);
    expect(db.count("work_interval")).toBe(2);
  });

  it("a partially applied batch still reports every present id", async () => {
    // The real shape of this: an earlier request committed some of the ids and
    // its response was lost. The retry sends the whole page again.
    const { env, db } = harness();
    await post(env, [makeRow("landed-1"), makeRow("landed-2")]);

    const retry = await post(env, [
      makeRow("landed-1"),
      makeRow("landed-2"),
      makeRow("new-3"),
      makeRow("new-4"),
    ]);
    const body = await json<PostResponse>(retry);
    expect(body.present.map((p) => p.id).sort()).toEqual([
      "landed-1",
      "landed-2",
      "new-3",
      "new-4",
    ]);
    expect(db.count("work_interval")).toBe(4);
  });

  it("reports presence keyed on the server's own read-back, not on the insert result", async () => {
    // A row the server already holds but that is NOT in this request must not
    // appear; a row in this request that the server holds must. Presence is a
    // property of the database, not of what this INSERT happened to change.
    const { env } = harness();
    await post(env, [makeRow("older")]);
    const res = await post(env, [makeRow("newer")]);
    const body = await json<PostResponse>(res);
    expect(body.present.map((p) => p.id)).toEqual(["newer"]);
  });
});

describe("POST /intervals — the 100-bound-parameter cap", () => {
  // Every assertion below is against D1_BOUND_PARAM_LIMIT, which fake-d1.ts
  // states independently as D1's documented ceiling. Asserting against the
  // Worker's own D1_MAX_BOUND_PARAMS would pass vacuously if someone raised it.
  it("states the cap as 100 and derives 6 rows per statement from it", () => {
    expect(D1_MAX_BOUND_PARAMS).toBe(D1_BOUND_PARAM_LIMIT);
    expect(COLS).toHaveLength(16);
    expect(ROWS_PER_STMT).toBe(6);
    expect(ROWS_PER_STMT * COLS.length).toBeLessThanOrEqual(
      D1_BOUND_PARAM_LIMIT,
    );
  });

  it("a full 200-row batch is chunked and every row lands", async () => {
    const { env, db } = harness();
    const rows = makeRows(200);
    const res = await post(env, rows);
    expect(res.status).toBe(200);

    // ── The assertion that matters: no statement the Worker actually sent
    //    exceeded the cap. Read off the recorded binds, not re-derived from the
    //    same arithmetic the Worker used.
    expect(db.maxBoundParams()).toBeLessThanOrEqual(D1_BOUND_PARAM_LIMIT);
    expect(db.maxBoundParams()).toBeGreaterThan(0);
    // It really did have to chunk: 200 rows cannot be one statement.
    const inserts = db.binds.filter((b) => b.sql.includes("INSERT INTO work_interval"));
    expect(inserts.length).toBeGreaterThan(1);

    expect(db.count("work_interval")).toBe(200);
    const body = await json<PostResponse>(res);
    expect(body.present).toHaveLength(200);
    // Every seq is distinct and every id came back.
    expect(new Set(body.present.map((p) => p.seq)).size).toBe(200);
    expect(new Set(body.present.map((p) => p.id)).size).toBe(200);
    expect(body.present.map((p) => p.id).sort()).toEqual(
      rows.map((r) => r["id"] as string).sort(),
    );
  });

  it("chunks the presence read-back too — 200 ids will not fit in one IN list", async () => {
    const { env, db } = harness();
    await post(env, makeRows(200));
    const selects = db.binds.filter((b) => b.sql.includes("SELECT id, seq"));
    expect(selects.length).toBeGreaterThan(1);
    for (const s of selects) {
      expect(s.params.length).toBeLessThanOrEqual(D1_BOUND_PARAM_LIMIT);
    }
  });

  it("rejects a batch larger than the page size rather than absorbing it", async () => {
    const { env, db } = harness();
    expect(MAX_ROWS_PER_REQUEST).toBe(200);
    const res = await post(env, makeRows(MAX_ROWS_PER_REQUEST + 1));
    expect(res.status).toBe(413);
    expect(db.count("work_interval")).toBe(0);
  });

  it("an exact multiple and a ragged remainder both land completely", async () => {
    // Literal counts, not multiples of ROWS_PER_STMT: the test input must not
    // move when the chunk size does.
    for (const n of [1, 5, 6, 7, 18, 19, 100]) {
      const { env, db } = harness();
      const res = await post(env, makeRows(n, `n${n}`));
      expect(res.status, `n=${n}`).toBe(200);
      expect(db.count("work_interval"), `n=${n}`).toBe(n);
      expect(db.maxBoundParams(), `n=${n}`).toBeLessThanOrEqual(
        D1_BOUND_PARAM_LIMIT,
      );
      expect((await json<PostResponse>(res)).present, `n=${n}`).toHaveLength(n);
    }
  });
});

describe("POST /intervals — bodies", () => {
  it("accepts an empty batch as a no-op", async () => {
    const { env, db } = harness();
    const res = await post(env, []);
    expect(res.status).toBe(200);
    expect((await json<PostResponse>(res)).present).toEqual([]);
    expect(db.count("work_interval")).toBe(0);
  });

  it("rejects a malformed body with 400 and writes nothing", async () => {
    const { env, db } = harness();
    const bad: Array<{ why: string; opts: Record<string, unknown> }> = [
      { why: "not json", opts: { rawBody: "{{{" } },
      { why: "no rows", opts: { body: {} } },
      { why: "rows not an array", opts: { body: { rows: "nope" } } },
      { why: "row is not an object", opts: { body: { rows: [42] } } },
      { why: "row has no id", opts: { body: { rows: [{ tz: "UTC" }] } } },
      { why: "id is empty", opts: { body: { rows: [makeRow("")] } } },
      { why: "id is a number", opts: { body: { rows: [makeRow("x")] .map((r) => ({ ...r, id: 7 }))} } },
    ];
    for (const { why, opts } of bad) {
      const res = await call(env, {
        method: "POST",
        path: "/intervals",
        token: TOKEN_PERSONAL,
        ...opts,
      });
      expect(res.status, why).toBe(400);
    }
    expect(db.count("work_interval")).toBe(0);
  });

  it("honours the schema DEFAULTs for counters the client omitted", async () => {
    // Naming a column and binding NULL defeats its DEFAULT clause, so a
    // `NOT NULL DEFAULT 0` column would fail the whole batch. Only running the
    // real DDL catches this.
    const { env, db } = harness();
    const sparse = makeRow("sparse");
    for (const c of [
      "key_events",
      "mouse_events",
      "camera_s",
      "jiggler_s",
      "schema_v",
    ]) {
      delete sparse[c];
    }
    const res = await post(env, [sparse]);
    expect(res.status).toBe(200);
    expect(
      db.query("SELECT key_events, mouse_events, camera_s, jiggler_s, schema_v FROM work_interval"),
    ).toEqual([
      {
        key_events: 0,
        mouse_events: 0,
        camera_s: 0,
        jiggler_s: 0,
        schema_v: 1,
      },
    ]);
  });
});

describe("GET /intervals", () => {
  it("returns rows strictly after the watermark, in seq order", async () => {
    const { env } = harness();
    await post(env, makeRows(5, "seq"));

    const all = await json<{ rows: Array<{ seq: number; id: string }> }>(
      await call(env, {
        method: "GET",
        path: "/intervals?since=0",
        token: TOKEN_PERSONAL,
      }),
    );
    expect(all.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);

    const after = await json<{ rows: Array<{ seq: number }> }>(
      await call(env, {
        method: "GET",
        path: "/intervals?since=3",
        token: TOKEN_PERSONAL,
      }),
    );
    expect(after.rows.map((r) => r.seq)).toEqual([4, 5]);
  });

  it("clamps the limit and survives junk query parameters", async () => {
    const { env } = harness();
    await post(env, makeRows(5, "junk"));
    for (const q of [
      "?since=0&limit=2",
      "?since=abc&limit=abc",
      "?since=-99&limit=99999",
      "",
    ]) {
      const res = await call(env, {
        method: "GET",
        path: `/intervals${q}`,
        token: TOKEN_PERSONAL,
      });
      expect(res.status, q).toBe(200);
      const body = await json<{ rows: unknown[] }>(res);
      expect(body.rows.length, q).toBe(q.includes("limit=2") ? 2 : 5);
    }
  });

  it("returns rows from BOTH machines — the pull is not scoped to the caller", async () => {
    // Each Mac holds the full merged history; that is backup layer 1.
    const { env } = harness();
    await post(env, [makeRow("p")], TOKEN_PERSONAL);
    await post(env, [makeRow("w")], TOKEN_WORK);
    const body = await json<{ rows: Array<{ machine_id: string }> }>(
      await call(env, {
        method: "GET",
        path: "/intervals",
        token: TOKEN_PERSONAL,
      }),
    );
    expect(body.rows.map((r) => r.machine_id).sort()).toEqual(
      [MACHINE_PERSONAL, MACHINE_WORK].sort(),
    );
  });
});
