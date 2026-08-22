import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  authenticate,
  presentedToken,
  sha256Hex,
  timingSafeEqual,
} from "../src/auth.js";
import {
  call,
  harness,
  json,
  makeRow,
  sha256HexNode,
  MACHINE_A,
  MACHINE_B,
  TOKEN_A,
  TOKEN_B,
  type PostResponse,
} from "./harness.js";

function req(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set("authorization", header);
  return new Request("https://wwb-sync.test/intervals", { headers });
}

/** Both machines enrolled and live — the ordinary steady state. */
function twoMachines() {
  return harness({
    enrolled: [
      { token: TOKEN_A, machineId: MACHINE_A },
      { token: TOKEN_B, machineId: MACHINE_B },
    ],
  });
}

describe("bearer tokens resolve through the registry", () => {
  it("rejects a request with no bearer token with 401", async () => {
    const { env } = harness();
    for (const path of ["/intervals", "/heartbeat", "/fingerprint"]) {
      const res = await call(env, { method: "GET", path });
      expect(res.status, path).toBe(401);
    }
  });

  it("rejects a token in no registry row with 401, and writes nothing", async () => {
    const { env, db } = harness();
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: "not-a-real-token-attacker-cccccccccccccccccc",
      body: { rows: [makeRow("nope")] },
    });
    expect(res.status).toBe(401);
    // Nothing was written on the way to the rejection.
    expect(db.count("work_interval")).toBe(0);
  });

  it("rejects a REVOKED token — this is the revocation guarantee", async () => {
    // Revoking a Mac is one UPDATE against D1. The token that Mac still holds
    // must stop working on its very next request, and must not fall through to
    // any other machine's identity.
    const { env, db } = harness({
      enrolled: [
        { token: TOKEN_A, machineId: MACHINE_A },
        { token: TOKEN_B, machineId: MACHINE_B, revoked: true },
      ],
    });
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_B,
      body: { rows: [makeRow("revoked")] },
    });
    expect(res.status).toBe(401);
    expect(db.count("work_interval")).toBe(0);
  });

  it("stamps each enrolled machine with its OWN id", async () => {
    const { env } = twoMachines();
    expect(await authenticate(req(`Bearer ${TOKEN_A}`), env)).toBe(MACHINE_A);
    expect(await authenticate(req(`Bearer ${TOKEN_B}`), env)).toBe(MACHINE_B);
  });

  it("authenticates nobody when the registry has zero live rows", async () => {
    // Fail closed. Identical to the old behaviour with unset secrets: an
    // unset credential is not a credential.
    const { env } = harness({ enrolled: [] });
    const health = await call(env, { method: "GET", path: "/health" });
    expect(health.status).toBe(200);
    for (const [method, path] of [
      ["POST", "/intervals"],
      ["GET", "/intervals"],
      ["POST", "/heartbeat"],
      ["GET", "/machines"],
      ["GET", "/fingerprint"],
    ] as const) {
      const res = await call(env, { method, path, token: TOKEN_A });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(await authenticate(req("Bearer "), env)).toBeNull();
    expect(await authenticate(req("Bearer x"), env)).toBeNull();
  });

  it("answers 503, not 401, when the registry table does not exist", async () => {
    // A Worker deployed without its schema is a deployment that was never
    // finished. A 401 here would send someone off to re-copy a perfect token —
    // the exact confusion this project is organised around.
    const { env } = harness({ noRegistry: true });
    const health = await call(env, { method: "GET", path: "/health" });
    expect(health.status).toBe(200);

    for (const [method, path] of [
      ["POST", "/intervals"],
      ["GET", "/intervals"],
      ["POST", "/heartbeat"],
      ["GET", "/machines"],
      ["GET", "/fingerprint"],
    ] as const) {
      const res = await call(env, { method, path, token: TOKEN_A });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(await res.text()).toBe("machine registry unavailable");
    }
  });

  it("rejects a row whose machine_id is empty rather than stamping a blank name", async () => {
    // Filing a year of hours under "" is the silent misattribution the whole
    // design exists to prevent. A rejected credential is strictly better.
    const { env, db } = harness({ enrolled: [{ token: TOKEN_A, machineId: "" }] });
    expect(await authenticate(req(`Bearer ${TOKEN_A}`), env)).toBeNull();
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_A,
      body: { rows: [makeRow("blank-id")] },
    });
    expect(res.status).toBe(401);
    expect(db.count("work_interval")).toBe(0);
  });

  it("accepts the scheme case-insensitively and rejects a header with no scheme", async () => {
    const { env } = twoMachines();
    expect(await authenticate(req(`bearer ${TOKEN_B}`), env)).toBe(MACHINE_B);
    expect(await authenticate(req(`BEARER ${TOKEN_B}`), env)).toBe(MACHINE_B);
    // A bare token with no scheme must not authenticate.
    expect(await authenticate(req(TOKEN_B), env)).toBeNull();
    expect(await authenticate(req(`Basic ${TOKEN_B}`), env)).toBeNull();
    expect(await authenticate(req(), env)).toBeNull();
  });

  it("extracts the token without leaking surrounding whitespace", () => {
    expect(presentedToken(req("Bearer   abc  "))).toBe("abc");
    expect(presentedToken(req("Bearer"))).toBe("");
    expect(presentedToken(req(""))).toBe("");
  });
});

describe("the comparison is constant-time and length-independent", () => {
  it("compares equal-length digests without early exit", () => {
    const a = new Uint8Array(32).fill(7);
    const b = new Uint8Array(32).fill(7);
    expect(timingSafeEqual(a, b)).toBe(true);

    // Differing in the FIRST byte and in the LAST byte must both be rejected.
    // A naive `===` on strings would short-circuit on the first; the point of
    // the XOR accumulator is that neither position is cheaper than the other.
    const first = new Uint8Array(32).fill(7);
    first[0] = 6;
    expect(timingSafeEqual(a, first)).toBe(false);

    const last = new Uint8Array(32).fill(7);
    last[31] = 6;
    expect(timingSafeEqual(a, last)).toBe(false);
  });

  it("refuses to compare different-length inputs", () => {
    expect(timingSafeEqual(new Uint8Array(32), new Uint8Array(31))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("never lets the presented token's length reach the comparison", async () => {
    // The presented value is absorbed into a fixed 64-character digest before
    // anything is looked up, so a 1-character guess and a 100,000-character
    // guess do the same work and get the same 401 — and neither throws.
    const { env } = twoMachines();
    for (const len of [1, 8, 31, 32, 33, 100_000]) {
      const res = await call(env, {
        method: "GET",
        path: "/fingerprint",
        token: "z".repeat(len),
      });
      expect(res.status, `length ${len}`).toBe(401);
    }
  });

  it("a token that is a prefix of a live one is still rejected", async () => {
    const { env } = twoMachines();
    const res = await call(env, {
      method: "GET",
      path: "/fingerprint",
      token: TOKEN_A.slice(0, -1),
    });
    expect(res.status).toBe(401);
  });
});

describe("the hash agrees across the two implementations that compute it", () => {
  /**
   * The app enrols with `node:crypto`; the Worker looks up with WebCrypto. If
   * these ever disagreed, every machine would 401 forever and nothing anywhere
   * would say why. The whole harness already depends on this — it seeds with
   * node:crypto and the Worker reads with WebCrypto — but pin it directly too,
   * because a shared bug in both directions is the failure worth naming.
   */
  it("matches node:crypto for ordinary, empty, unicode and minted-shape inputs", async () => {
    const minted = randomBytes(32).toString("base64");
    const cases = [
      "",
      "a",
      TOKEN_A,
      TOKEN_B,
      minted,
      "ünïcødé — em-dash and a ✅",
      "z".repeat(10_000),
    ];
    for (const s of cases) {
      expect(await sha256Hex(s), JSON.stringify(s.slice(0, 24))).toBe(
        sha256HexNode(s),
      );
    }
  });

  it("produces 64 lowercase hex characters — the format the registry stores", async () => {
    expect(await sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a token enrolled with a node:crypto hash authenticates against WebCrypto", async () => {
    // The end-to-end version of the above: this is exactly what enrolment does.
    const minted = randomBytes(32).toString("base64");
    const { env } = harness({
      enrolled: [{ token: minted, machineId: MACHINE_A }],
    });
    expect(await authenticate(req(`Bearer ${minted}`), env)).toBe(MACHINE_A);
  });
});

describe("/health", () => {
  it("answers without a token — it is the bring-up probe, and touches no data", async () => {
    const { env } = harness();
    const res = await call(env, { method: "GET", path: "/health" });
    expect(res.status).toBe(200);
    expect(await json<{ ok: boolean }>(res)).toMatchObject({ ok: true });
  });

  it("is the only unauthenticated route", async () => {
    const { env } = harness();
    for (const [method, path] of [
      ["POST", "/intervals"],
      ["GET", "/intervals"],
      ["POST", "/heartbeat"],
      ["GET", "/fingerprint"],
    ] as const) {
      const res = await call(env, { method, path });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("authenticates before it 404s, so an anonymous caller cannot map the routes", async () => {
    // An unknown path answers 401 without a token and 404 with one. That
    // ordering is what stops the route surface being probed anonymously.
    const { env } = harness();
    expect((await call(env, { method: "GET", path: "/secret" })).status).toBe(
      401,
    );
    expect(
      (await call(env, { method: "GET", path: "/secret", token: TOKEN_A }))
        .status,
    ).toBe(404);
  });
});

describe("the machine id comes from the token", () => {
  it("stamps rows with the posting token's machine, not the body's claim", async () => {
    const { env, db } = twoMachines();
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_B,
      body: { rows: [makeRow("from-b")] },
    });
    expect(res.status).toBe(200);
    expect((await json<PostResponse>(res)).present).toHaveLength(1);
    expect(
      db.query<{ machine_id: string }>("SELECT machine_id FROM work_interval"),
    ).toEqual([{ machine_id: MACHINE_B }]);
  });

  it("two enrolled machines each stamp their own id, from the same Worker", async () => {
    const { env, db } = twoMachines();
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_A,
      body: { rows: [makeRow("by-a")] },
    });
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_B,
      body: { rows: [makeRow("by-b")] },
    });
    expect(
      db.query<{ id: string; machine_id: string }>(
        "SELECT id, machine_id FROM work_interval ORDER BY id",
      ),
    ).toEqual([
      { id: "by-a", machine_id: MACHINE_A },
      { id: "by-b", machine_id: MACHINE_B },
    ]);
  });

  it("a token cannot mint itself a second identity — no route writes the registry", async () => {
    const { env, db } = twoMachines();
    expect(db.count("machine_token")).toBe(2);
    // Drive every route with a valid token and prove the registry is untouched.
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_A,
      body: { rows: [makeRow("r1")] },
    });
    await call(env, { method: "GET", path: "/intervals", token: TOKEN_A });
    await call(env, {
      method: "POST",
      path: "/heartbeat",
      token: TOKEN_A,
      body: { label: "A" },
    });
    await call(env, { method: "GET", path: "/machines", token: TOKEN_A });
    await call(env, { method: "GET", path: "/fingerprint", token: TOKEN_A });
    expect(db.count("machine_token")).toBe(2);
    expect(
      db.query<{ machine_id: string; revoked_at_ms: number | null }>(
        "SELECT machine_id, revoked_at_ms FROM machine_token ORDER BY machine_id",
      ),
    ).toEqual([
      { machine_id: MACHINE_A, revoked_at_ms: null },
      { machine_id: MACHINE_B, revoked_at_ms: null },
    ]);
  });
});

describe("the registry never leaks through a response", () => {
  it("no route body contains a token, its digest, or the column name", async () => {
    const { env } = twoMachines();
    const digestA = sha256HexNode(TOKEN_A);
    const digestB = sha256HexNode(TOKEN_B);

    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_A,
      body: { rows: [makeRow("leak-check")] },
    });
    await call(env, {
      method: "POST",
      path: "/heartbeat",
      token: TOKEN_A,
      body: { label: "A" },
    });

    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", "/intervals"],
      ["GET", "/machines"],
      ["GET", "/fingerprint"],
    ] as const) {
      const res = await call(env, { method, path, token: TOKEN_A });
      const body = await res.text();
      expect(body, `${method} ${path}`).not.toContain("token_sha256");
      expect(body, `${method} ${path}`).not.toContain(digestA);
      expect(body, `${method} ${path}`).not.toContain(digestB);
      expect(body, `${method} ${path}`).not.toContain(TOKEN_A);
      expect(body, `${method} ${path}`).not.toContain(TOKEN_B);
    }
  });
});
