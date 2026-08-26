/**
 * The Cloudflare REST client.
 *
 * Two things are worth testing at this level rather than through the wizard:
 *
 *   * THE WIRE. The multipart body, the metadata part, the module part's name,
 *     and the `?bindings_inherit=strict` query string. These were checked
 *     against Cloudflare's published OpenAPI schema; this pins that they are
 *     still what goes out.
 *   * THE ERRORS. Every failure has to name a fix. A 403 has to say which
 *     permission is missing, and it must not be confused with a bad token or a
 *     dead network.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createCloudflareApi, toSubdomainLabel, workersDevUrl } from "../../src/cloud/api";
import {
  CloudflareApiError,
  describeFetchFailure,
  isTlsNotReady,
  redactSecrets,
} from "../../src/cloud/errors";
import {
  FAKE_ACCOUNT_ID,
  FAKE_API_TOKEN,
  FAKE_BASE,
  FakeCloudflare,
} from "./fake-cloudflare";

let cloud: FakeCloudflare;

function api(token = FAKE_API_TOKEN) {
  return createCloudflareApi({
    apiToken: token,
    fetchImpl: cloud.fetch,
    baseUrl: FAKE_BASE,
  });
}

beforeEach(() => {
  cloud = new FakeCloudflare();
});

describe("the upload's wire format", () => {
  const upload = {
    scriptName: "wwb-sync",
    script: "export default { fetch() {} };",
    mainModule: "index.js",
    compatibilityDate: "2026-08-01",
    bindings: [{ type: "d1", name: "DB", database_id: "db-1" }],
  } as const;

  it("always asks for strict inherit resolution", async () => {
    await api().uploadWorker(FAKE_ACCOUNT_ID, upload);
    // Not a parameter, and it must not become one. Cloudflare's own schema:
    // "Without this, unresolvable inherit bindings are silently dropped."
    expect(cloud.uploads.at(-1)?.strict).toBe(true);
  });

  it("names the module part after main_module", async () => {
    await api().uploadWorker(FAKE_ACCOUNT_ID, upload);
    const record = cloud.uploads.at(-1);
    // The fake refuses the upload if `main_module` does not name an uploaded
    // part, which is what Cloudflare does too.
    expect(record?.mainModule).toBe("index.js");
    expect(record?.script).toBe(upload.script);
  });

  it("sends the compatibility date, so the runtime is not 2021-11-02", async () => {
    await api().uploadWorker(FAKE_ACCOUNT_ID, upload);
    expect(cloud.uploads.at(-1)?.compatibilityDate).toBe("2026-08-01");
  });
});

describe("strict inherit is what prevents silent token loss", () => {
  /**
   * The point of this pair: prove the FLAG is doing the work, not the shape of
   * the request. The fake models both behaviours because Cloudflare does, and
   * the non-strict one is the silent data loss the flag exists to prevent.
   */
  const bindings = [
    { type: "d1", name: "DB", database_id: "db-1" },
    { type: "inherit", name: "TOKEN_WORK" },
  ] as const;

  it("carries an existing binding across an upload that cannot read it", async () => {
    cloud.seedScript([
      { type: "d1", name: "DB", database_id: "db-1" },
      { type: "secret_text", name: "TOKEN_WORK", text: "the-other-macs-token" },
    ]);
    await api().uploadWorker(FAKE_ACCOUNT_ID, {
      scriptName: "wwb-sync",
      script: "export default {};",
      mainModule: "index.js",
      compatibilityDate: "2026-08-01",
      bindings,
    });
    expect(cloud.bindingValue("TOKEN_WORK")).toBe("the-other-macs-token");
  });

  it("fails loudly rather than dropping an inherit it cannot resolve", async () => {
    // Nothing to inherit from: no previous version has TOKEN_WORK.
    cloud.seedScript([{ type: "d1", name: "DB", database_id: "db-1" }]);
    await expect(
      api().uploadWorker(FAKE_ACCOUNT_ID, {
        scriptName: "wwb-sync",
        script: "export default {};",
        mainModule: "index.js",
        compatibilityDate: "2026-08-01",
        bindings,
      }),
    ).rejects.toThrow(/inherit binding "TOKEN_WORK" could not be resolved/);
  });

  it("would have lost it without the flag — which is why the flag is not optional", async () => {
    cloud.seedScript([
      { type: "d1", name: "DB", database_id: "db-1" },
      { type: "secret_text", name: "TOKEN_WORK", text: "the-other-macs-token" },
    ]);
    // Deliberately bypassing the client to reach the URL it refuses to build.
    const form = new FormData();
    form.append(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "index.js",
            bindings: [{ type: "inherit", name: "TOKEN_MISSING" }],
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.append("index.js", new Blob(["export default {};"]), "index.js");
    const res = await cloud.fetch(
      `${FAKE_BASE}/accounts/${FAKE_ACCOUNT_ID}/workers/scripts/wwb-sync`,
      { method: "PUT", headers: { authorization: `Bearer ${FAKE_API_TOKEN}` }, body: form },
    );

    // 200, and the binding is simply gone. On a real account that is the other
    // Mac silently offline behind a successful-looking deploy.
    expect(res.status).toBe(200);
    expect(cloud.bindingValue("TOKEN_WORK")).toBeUndefined();
  });
});

describe("secrets never come back", () => {
  it("omits a secret_text value from the settings response", async () => {
    cloud.seedScript([
      { type: "secret_text", name: "TOKEN_PERSONAL", text: "shhh" },
      { type: "plain_text", name: "MACHINE_ID_PERSONAL", text: "MACHINE-A" },
    ]);
    const bindings = await api().getWorkerBindings(FAKE_ACCOUNT_ID, "wwb-sync");

    const secret = bindings?.find((b) => b.name === "TOKEN_PERSONAL");
    expect(secret?.type).toBe("secret_text");
    expect(secret?.text).toBeNull();

    // A plain_text value DOES come back. Nothing depends on that any more —
    // the app stores nothing in a binding but the database id — but the
    // asymmetry is still what the endpoint promises, so it stays asserted.
    const machineId = bindings?.find((b) => b.name === "MACHINE_ID_PERSONAL");
    expect(machineId?.text).toBe("MACHINE-A");
  });

  it("reports a missing script as null, not as an error", async () => {
    // No Worker yet is the ordinary first-run state.
    expect(await api().getWorkerBindings(FAKE_ACCOUNT_ID, "wwb-sync")).toBeNull();
  });
});

describe("queryParams binds rather than interpolates", () => {
  it("sends {sql, params} and leaves the placeholder in the SQL", async () => {
    // The regression guard for a real bug: `query()` string-interpolates, which
    // was harmless while every caller passed a constant and became an injection
    // site the moment enrolment put a machine id in a statement.
    const db = cloud.seedDatabase("wwb");
    db.schemaApplied = true;
    await api().queryParams(
      FAKE_ACCOUNT_ID,
      db.uuid,
      "INSERT INTO machine_token (token_sha256, machine_id, enrolled_at_ms) VALUES (?, ?, ?)",
      ["a".repeat(64), "MACHINE-A", "1760000000000"],
    );
    const body = cloud.lastQueryBody();
    expect(body?.sql).toContain("?");
    expect(body?.params).toEqual(["a".repeat(64), "MACHINE-A", "1760000000000"]);
    // The values must not appear spliced into the statement itself.
    expect(body?.sql).not.toContain("MACHINE-A");
  });

  it("does not send a params key at all on the constant-SQL path", async () => {
    const db = cloud.seedDatabase("wwb");
    await api().query(FAKE_ACCOUNT_ID, db.uuid, "SELECT 1;");
    expect(cloud.lastQueryBody()?.params).toBeUndefined();
  });
});

describe("probeScopes tries, because scopes cannot be read", () => {
  it("reports ok for everything a full token can reach", async () => {
    expect(await api().probeScopes(FAKE_ACCOUNT_ID)).toEqual({
      d1: "ok",
      workers: "ok",
      accountRead: "ok",
    });
  });

  it("reports the missing one as missing, for a 403", async () => {
    cloud.denied.add("D1: Read");
    const scopes = await api().probeScopes(FAKE_ACCOUNT_ID);
    expect(scopes.d1).toBe("missing");
    expect(scopes.workers).toBe("ok");
  });

  it("reports the missing one as missing when Cloudflare answers 401 instead", async () => {
    // Cloudflare has answered a missing scope with BOTH statuses. The probe
    // must not care which it got — see Rule A in errors.ts.
    cloud.denied.add("D1: Read");
    cloud.denyStatus = 401;
    expect((await api().probeScopes(FAKE_ACCOUNT_ID)).d1).toBe("missing");
  });

  it("creates nothing and changes nothing", async () => {
    await api().probeScopes(FAKE_ACCOUNT_ID);
    const mutating = cloud.calls.filter(
      (c) => c.method === "POST" || c.method === "PUT" || c.method === "DELETE",
    );
    expect(mutating).toEqual([]);
  });
});

describe("errors say what to do", () => {
  it("names the permission a 403 needs, per operation", async () => {
    cloud.denied.add("D1: Edit");
    const err = await api()
      .createDatabase(FAKE_ACCOUNT_ID, "wwb")
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).permission).toBe("D1: Edit");
    expect((err as Error).message).toContain("D1: Edit");
    expect((err as Error).message).toContain("creating the D1 database");
    expect((err as Error).message).toContain("Account level");
  });

  it("does not offer a permission for a 401 — there is no token to edit", async () => {
    const err = await api("wrong")
      .verifyToken()
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toContain("did not accept that API token");
    expect((err as Error).message).not.toContain("permission");
  });

  it("distinguishes a dead network from anything Cloudflare said", async () => {
    cloud.offline = true;
    const err = await api()
      .verifyToken()
      .then(() => null, (e: unknown) => e);
    expect((err as Error).name).toBe("CloudflareNetworkError");
    expect((err as Error).message).toContain("could not reach api.cloudflare.com");
    expect((err as Error).message).toContain("proxy");
  });

  it("explains a 429 as rate limiting rather than a failure to fix", async () => {
    cloud.failOnce.set("/d1/database", 429);
    const err = await api()
      .listDatabases(FAKE_ACCOUNT_ID)
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toContain("rate-limiting");
    expect((err as Error).message).toContain("Wait five minutes");
  });

  it("says a 5xx is Cloudflare's and safe to retry", async () => {
    cloud.failOnce.set("/d1/database", 503);
    const err = await api()
      .listDatabases(FAKE_ACCOUNT_ID)
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toContain("their side");
  });

  it("treats a token that may not list accounts as an empty list, not a failure", async () => {
    cloud.denied.add("Account Settings: Read");
    expect(await api().listAccounts()).toEqual([]);
  });
});

describe("URL composition", () => {
  it("composes the workers.dev address from parts that were read back", () => {
    expect(workersDevUrl("wwb-sync", "someones-subdomain")).toBe(
      "https://wwb-sync.someones-subdomain.workers.dev",
    );
  });

  it("reduces a name to a DNS label", () => {
    // workers.dev names are DNS labels: 63 chars, a-z0-9-, no edge dashes.
    expect(toSubdomainLabel("Brendan's Mac!")).toBe("brendan-s-mac");
    expect(toSubdomainLabel("--x--")).toBe("x");
    expect(toSubdomainLabel("a".repeat(80))).toHaveLength(63);
  });
});

describe("redaction is the last line of defence", () => {
  it("removes anything credential-shaped from a message", () => {
    expect(redactSecrets("Bearer abc123def456")).toBe("Bearer ***");
    expect(redactSecrets(`token ${"a1b2c3d4".repeat(6)} rejected`)).toBe("token *** rejected");
    // A base64 Worker token is 44 characters.
    expect(redactSecrets(`x ${"A".repeat(43)}= y`)).toBe("x *** y");
  });

  it("leaves ordinary prose alone", () => {
    const plain = "the Worker is reachable but rejected this token";
    expect(redactSecrets(plain)).toBe(plain);
  });
});

/**
 * The whole diagnosis, and the reason commit 1 ships on its own.
 *
 * A work Mac failed setup's final reachability check and the only thing it
 * could report was `fetch failed`. Four different faults produce exactly that
 * string, they need four different fixes, and every one of them is
 * distinguishable — the evidence is on `err.cause` and every caller was
 * throwing it away.
 */
describe("naming a failed fetch", () => {
  /** What undici actually throws: the message is useless, the cause is not. */
  function fetchFailed(cause: unknown): TypeError {
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  const cases = [
    ["ENOTFOUND", "does not resolve"],
    ["EAI_AGAIN", "does not resolve"],
    ["ERR_NAME_NOT_RESOLVED", "does not resolve"],
    ["ECONNREFUSED", "refused"],
    ["ERR_CONNECTION_REFUSED", "refused"],
    ["ECONNRESET", "proxy dropped it"],
    ["ERR_CONNECTION_RESET", "proxy dropped it"],
    ["ERR_CONNECTION_CLOSED", "proxy dropped it"],
    ["UND_ERR_CONNECT_TIMEOUT", "timed out"],
    ["ETIMEDOUT", "timed out"],
    ["ERR_CONNECTION_TIMED_OUT", "timed out"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "does not read macOS's trust store"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "does not read macOS's trust store"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "does not read macOS's trust store"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "does not read macOS's trust store"],
    ["ERR_CERT_AUTHORITY_INVALID", "does not read macOS's trust store"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "does not name that hostname"],
    ["ERR_CERT_COMMON_NAME_INVALID", "does not name that hostname"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["ERR_CERT_DATE_INVALID", "certificate has expired"],
    ["EPROTO", "TLS handshake failed"],
    ["ERR_SSL_PROTOCOL_ERROR", "TLS handshake failed"],
    ["ERR_SSL_VERSION_OR_CIPHER_MISMATCH", "TLS handshake failed"],
  ] as const;

  it.each(cases)("turns cause code %s into words", (code, expected) => {
    expect(describeFetchFailure(fetchFailed({ code }))).toContain(expected);
  });

  it("never answers “fetch failed”, which is the whole point", () => {
    for (const [code] of cases) {
      expect(describeFetchFailure(fetchFailed({ code }))).not.toContain("fetch failed");
    }
  });

  it("separates the four the owner's Mac could be in", () => {
    // Measured on Node 22: these four are what NXDOMAIN, a self-signed cert, an
    // untrusted corporate root and a wrong hostname come back as. They want
    // four different actions, so they must not read alike.
    const four = [
      "ENOTFOUND",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].map((code) => describeFetchFailure(fetchFailed({ code })));
    expect(new Set(four).size).toBe(3);
    // The two untrusted-root codes are one world and say one thing; the other
    // two are worlds of their own.
    expect(four[1]).toBe(four[2]);
  });

  it("finds the code however deep the cause chain goes", () => {
    const deep = fetchFailed(fetchFailed(fetchFailed({ code: "ECONNREFUSED" })));
    expect(describeFetchFailure(deep)).toContain("refused");
  });

  it("reads the first member of an AggregateError, which multi-address connects throw", () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ENOTFOUND" })]), {});
    expect(describeFetchFailure(fetchFailed(aggregate))).toContain("does not resolve");
  });

  it("survives a cause chain that points at itself", () => {
    const looped: { cause?: unknown } = new TypeError("fetch failed");
    looped.cause = looped;
    expect(describeFetchFailure(looped)).toBe("fetch failed");
  });

  it("names a timeout, which arrives as a name rather than a code", () => {
    // `AbortSignal.timeout` rejects with a DOMException. Its `code` is the
    // NUMBER 20; only the name identifies it.
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
      code: 20,
    });
    expect(describeFetchFailure(aborted)).toContain("did not answer within the timeout");
  });

  it("still says something specific for a code it has never seen", () => {
    const out = describeFetchFailure(fetchFailed({ code: "ESOMETHINGNEW" }));
    expect(out).toBe("ESOMETHINGNEW");
    expect(out).not.toContain("[object Object]");
  });

  it("falls back to the deepest message when there is no code anywhere", () => {
    expect(describeFetchFailure(new Error("the schema was never applied"))).toBe(
      "the schema was never applied",
    );
    expect(describeFetchFailure(fetchFailed({ message: "socket hang up" }))).toBe(
      "socket hang up",
    );
    expect(describeFetchFailure(fetchFailed({}))).toBe("fetch failed");
  });

  it("redacts, because a cause message is a string from a library", () => {
    const leaky = fetchFailed({ message: `rejected Bearer ${"a1b2c3d4".repeat(6)}` });
    expect(describeFetchFailure(leaky)).not.toContain("a1b2c3d4");
    expect(describeFetchFailure(leaky)).toContain("***");
  });

  it("classifies only a certificate that may not exist yet as worth retrying", () => {
    // A three-minute wait for a connection that was REFUSED is a bug, not
    // patience. Retry only what a minute-old address does.
    for (const code of ["EPROTO", "ERR_SSL_PROTOCOL_ERROR", "ERR_TLS_CERT_ALTNAME_INVALID", "ENOTFOUND"]) {
      expect(isTlsNotReady(fetchFailed({ code }))).toBe(true);
    }
    for (const code of ["ECONNRESET", "ECONNREFUSED", "SELF_SIGNED_CERT_IN_CHAIN"]) {
      expect(isTlsNotReady(fetchFailed({ code }))).toBe(false);
    }
    expect(isTlsNotReady(new Error("no code here"))).toBe(false);
  });

  it("reaches the sentence a failed Cloudflare call shows", async () => {
    const dead = createCloudflareApi({
      apiToken: FAKE_API_TOKEN,
      baseUrl: FAKE_BASE,
      fetchImpl: () => Promise.reject(fetchFailed({ code: "SELF_SIGNED_CERT_IN_CHAIN" })),
    });
    const err = await dead.verifyToken().then(() => null, (e: unknown) => e);
    expect((err as Error).message).toContain("does not read macOS's trust store");
    expect((err as Error).message).not.toContain("fetch failed");
  });
});
