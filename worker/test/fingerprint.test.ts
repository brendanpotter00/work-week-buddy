import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { fingerprintSha256 } from "../src/fingerprint.js";
import {
  call,
  harness,
  json,
  makeRow,
  TOKEN_PERSONAL,
  TOKEN_WORK,
} from "./harness.js";

interface Fingerprint {
  readonly count: number;
  readonly maxEndedAtMs: number;
  readonly sha256: string;
}

/**
 * An INDEPENDENT implementation of the documented hash, via node:crypto rather
 * than WebCrypto. T4.4 will copy the definition into the client; until that
 * exists, this is the cross-check that matters — two separate code paths
 * agreeing on "sorted ASCII-ascending, joined \n, no trailing newline, UTF-8,
 * lowercase hex". A client and server that disagree about the joining character
 * produce a permanent mismatch alarm that looks exactly like real data loss.
 */
function referenceSha(ids: readonly string[]): string {
  return createHash("sha256")
    .update(Buffer.from([...ids].sort().join("\n"), "utf8"))
    .digest("hex");
}

async function fetchFingerprint(env: Parameters<typeof call>[0]) {
  const res = await call(env, {
    method: "GET",
    path: "/fingerprint",
    token: TOKEN_PERSONAL,
  });
  expect(res.status).toBe(200);
  return json<Fingerprint>(res);
}

describe("the fingerprint hash definition", () => {
  it("hashes sorted ids joined by newline with no trailing newline", async () => {
    expect(await fingerprintSha256(["b", "a", "c"])).toBe(referenceSha(["a", "b", "c"]));
    // Explicitly NOT the trailing-newline variant, and NOT comma-joined.
    const withTrailing = createHash("sha256").update("a\nb\nc\n", "utf8").digest("hex");
    const commaJoined = createHash("sha256").update("a,b,c", "utf8").digest("hex");
    const actual = await fingerprintSha256(["a", "b", "c"]);
    expect(actual).not.toBe(withTrailing);
    expect(actual).not.toBe(commaJoined);
    expect(actual).toBe(createHash("sha256").update("a\nb\nc", "utf8").digest("hex"));
  });

  it("is lowercase hex, 64 characters", async () => {
    const sha = await fingerprintSha256(["one", "two"]);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the empty string for an empty table — a real value, not a special case", async () => {
    expect(await fingerprintSha256([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the independent implementation over 500 ids", async () => {
    const ids = Array.from(
      { length: 500 },
      (_, i) => `0199a2b4-${String(i).padStart(4, "0")}-7000-8000-000000000000`,
    );
    // Shuffled input, identical digest: the sort is what makes it canonical.
    const shuffled = [...ids].reverse();
    expect(await fingerprintSha256(shuffled)).toBe(referenceSha(ids));
    expect(await fingerprintSha256(ids)).toBe(
      await fingerprintSha256(shuffled),
    );
  });

  it("is sensitive to a single missing or extra id", async () => {
    const ids = ["a", "b", "c"];
    expect(await fingerprintSha256(ids)).not.toBe(
      await fingerprintSha256(["a", "b"]),
    );
    expect(await fingerprintSha256(ids)).not.toBe(
      await fingerprintSha256([...ids, "d"]),
    );
  });
});

describe("GET /fingerprint", () => {
  it("is stable regardless of the order the rows were inserted in", async () => {
    const ids = ["id-c", "id-a", "id-e", "id-b", "id-d"];

    // Machine 1: inserted one at a time, in one order.
    const forward = harness();
    for (const id of ids) {
      await call(forward.env, {
        method: "POST",
        path: "/intervals",
        token: TOKEN_PERSONAL,
        body: { rows: [makeRow(id)] },
      });
    }

    // Machine 2: the same ids, reversed, in a single batch, and posted by the
    // OTHER machine so machine_id differs too. The fingerprint is over ids.
    const reverse = harness();
    await call(reverse.env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_WORK,
      body: { rows: [...ids].reverse().map((id) => makeRow(id)) },
    });

    const a = await fetchFingerprint(forward.env);
    const b = await fetchFingerprint(reverse.env);

    expect(a.sha256).toBe(b.sha256);
    expect(a.count).toBe(b.count);
    expect(a.maxEndedAtMs).toBe(b.maxEndedAtMs);
    // And it is the documented value, not merely self-consistent.
    expect(a.sha256).toBe(referenceSha(ids));

    // seq really did differ — the two databases are not accidentally identical.
    expect(forward.db.query("SELECT id FROM work_interval ORDER BY seq")).not.toEqual(
      reverse.db.query("SELECT id FROM work_interval ORDER BY seq"),
    );
  });

  it("reports count and the maximum ended_at_ms", async () => {
    const { env } = harness();
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_PERSONAL,
      body: {
        rows: [
          makeRow("f1", { ended_at_ms: 1_700_000_000_000 }),
          makeRow("f2", { ended_at_ms: 1_800_000_000_000 }),
          makeRow("f3", { ended_at_ms: 1_600_000_000_000 }),
        ],
      },
    });
    const fp = await fetchFingerprint(env);
    expect(fp.count).toBe(3);
    expect(fp.maxEndedAtMs).toBe(1_800_000_000_000);
  });

  it("answers for an empty database instead of failing", async () => {
    const { env } = harness();
    const fp = await fetchFingerprint(env);
    expect(fp).toEqual({
      count: 0,
      maxEndedAtMs: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("changes when a row is added — this is the layer that catches silent loss", async () => {
    const { env } = harness();
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_PERSONAL,
      body: { rows: [makeRow("only")] },
    });
    const before = await fetchFingerprint(env);
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_PERSONAL,
      body: { rows: [makeRow("second")] },
    });
    const after = await fetchFingerprint(env);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.count).toBe(2);
  });
});
