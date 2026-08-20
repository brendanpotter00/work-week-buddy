import { describe, it, expect } from "vitest";
import {
  authenticate,
  presentedToken,
  stampedMachineId,
  timingSafeEqual,
} from "../src/auth.js";
import {
  call,
  harness,
  json,
  makeRow,
  MACHINE_PERSONAL,
  MACHINE_WORK,
  TOKEN_PERSONAL,
  TOKEN_WORK,
  type PostResponse,
} from "./harness.js";

function req(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set("authorization", header);
  return new Request("https://wwb-sync.test/intervals", { headers });
}

describe("bearer tokens", () => {
  it("rejects a request with no bearer token with 401", async () => {
    const { env } = harness();
    for (const path of ["/intervals", "/heartbeat", "/fingerprint"]) {
      const res = await call(env, { method: "GET", path });
      expect(res.status, path).toBe(401);
    }
  });

  it("rejects a token that belongs to neither machine with 401", async () => {
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

  it("rejects the other machine's token once that secret is rotated away", async () => {
    // Revoking the work Mac is one `wrangler secret put TOKEN_WORK`. The token
    // that Mac still holds must stop working immediately — and must not fall
    // through to the personal slot.
    const { env, db } = harness({ TOKEN_WORK: "not-a-real-token-work-rotated" });
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_WORK,
      body: { rows: [makeRow("revoked")] },
    });
    expect(res.status).toBe(401);
    expect(db.count("work_interval")).toBe(0);
  });

  it("treats an unset secret as no credential rather than as the empty string", async () => {
    // A Worker deployed before `wrangler secret put` must authenticate nobody.
    const { env } = harness({ TOKEN_PERSONAL: "", TOKEN_WORK: "" });
    expect(await authenticate(req("Bearer "), env)).toBeNull();
    expect(await authenticate(req("Bearer x"), env)).toBeNull();
  });

  it("maps the work token to the work machine id and the personal token to the personal one", async () => {
    const { env } = harness();
    expect(await authenticate(req(`Bearer ${TOKEN_WORK}`), env)).toBe("work");
    expect(await authenticate(req(`Bearer ${TOKEN_PERSONAL}`), env)).toBe(
      "personal",
    );
    expect(stampedMachineId(env, "work")).toBe(MACHINE_WORK);
    expect(stampedMachineId(env, "personal")).toBe(MACHINE_PERSONAL);
  });

  it("falls back to the slot name when the machine id env var is unset", async () => {
    const { env } = harness({
      MACHINE_ID_PERSONAL: undefined,
      MACHINE_ID_WORK: "",
    });
    expect(stampedMachineId(env, "personal")).toBe("personal");
    expect(stampedMachineId(env, "work")).toBe("work");
  });

  it("accepts the scheme case-insensitively and rejects a header with no scheme", async () => {
    const { env } = harness();
    expect(await authenticate(req(`bearer ${TOKEN_WORK}`), env)).toBe("work");
    expect(await authenticate(req(`BEARER ${TOKEN_WORK}`), env)).toBe("work");
    // A bare token with no scheme must not authenticate.
    expect(await authenticate(req(TOKEN_WORK), env)).toBeNull();
    expect(await authenticate(req(`Basic ${TOKEN_WORK}`), env)).toBeNull();
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
    // Both sides are hashed to 32 bytes first, so a 1-character guess and a
    // 100,000-character guess are indistinguishable to the comparator: the
    // response is 401 either way and nothing throws on the long one.
    const { env } = harness();
    for (const len of [1, 8, 31, 32, 33, 100_000]) {
      const res = await call(env, {
        method: "GET",
        path: "/fingerprint",
        token: "z".repeat(len),
      });
      expect(res.status, `length ${len}`).toBe(401);
    }
  });

  it("a token that is a prefix of the real one is still rejected", async () => {
    const { env } = harness();
    const res = await call(env, {
      method: "GET",
      path: "/fingerprint",
      token: TOKEN_PERSONAL.slice(0, -1),
    });
    expect(res.status).toBe(401);
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
      (await call(env, { method: "GET", path: "/secret", token: TOKEN_WORK }))
        .status,
    ).toBe(404);
  });
});

describe("the machine id comes from the token", () => {
  it("stamps rows posted with the work token as the work machine", async () => {
    const { env, db } = harness();
    const res = await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_WORK,
      body: { rows: [makeRow("from-work")] },
    });
    expect(res.status).toBe(200);
    expect((await json<PostResponse>(res)).present).toHaveLength(1);
    expect(
      db.query<{ machine_id: string }>("SELECT machine_id FROM work_interval"),
    ).toEqual([{ machine_id: MACHINE_WORK }]);
  });
});
