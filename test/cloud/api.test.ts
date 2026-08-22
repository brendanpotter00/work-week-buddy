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
import { CloudflareApiError, redactSecrets } from "../../src/cloud/errors";
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
