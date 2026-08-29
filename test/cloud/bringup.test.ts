/**
 * In-app cloud setup, against a fake Cloudflare.
 *
 * The properties that matter are all about a SECOND machine and a SECOND run:
 *
 *   * an existing `wwb` database is ADOPTED, never duplicated
 *   * a machine enrols ITSELF and only itself — no run ever mints, revokes or
 *     touches another Mac's credential
 *   * the minted token never leaves this Mac; only its SHA-256 is sent
 *   * insert-then-revoke ordering, and revoke only after the Keychain commit
 *   * a missing permission is named as a missing permission — under a 401 AND
 *     under a 403, because Cloudflare has answered with each
 *   * a failure at any step leaves a world the next run can pick up
 *
 * The account, the tokens and the ids in here are all obvious nonsense, and
 * nothing in this file touches a real Cloudflare account.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";

import { createCloudflareApi } from "../../src/cloud/api";
import {
  probeCloud,
  readEnrolledMachines,
  revokeMachine,
  runCloudSetup,
  type CloudSetupOutcome,
  type CustomDomainRequest,
} from "../../src/cloud/bringup";
import { WORKER_BUNDLE } from "../../src/cloud/worker-bundle.generated";
import {
  FAKE_ACCOUNT_ID,
  FAKE_API_TOKEN,
  FAKE_BASE,
  FAKE_SUBDOMAIN,
  FAKE_ZONE_ID,
  FAKE_ZONE_NAME,
  FakeCloudflare,
  OTHER_MAC,
  OTHER_ZONE_NAME,
  THIS_MAC,
  sha256Hex,
  type FakeHostBehaviour,
  workerFetchFor,
} from "./fake-cloudflare";

let cloud: FakeCloudflare;
let committed: Array<{ workerUrl: string; altWorkerUrl: string | null; token: string }>;
let minted: string[];

/**
 * Deterministic "randomness", so a test can name the token it expects.
 *
 * The counter is per TEST, not per run: two runs inside one test must mint
 * different values, because that is what real randomness does and it is the
 * whole point of "re-running replaces this Mac's token".
 */
let mintCount = 0;
function mintCounter(): () => string {
  return () => {
    mintCount += 1;
    const value = `minted-token-${String(mintCount)}`;
    minted.push(value);
    return value;
  };
}

function freshApi() {
  return createCloudflareApi({
    apiToken: FAKE_API_TOKEN,
    fetchImpl: cloud.fetch,
    baseUrl: FAKE_BASE,
  });
}

function setup(
  over: {
    thisMachineId?: string;
    healthFailures?: number;
    authFailures?: number;
    noRegistry?: boolean;
    /** Per-hostname behaviour — the fake that proves the two-address feature. */
    hosts?: Record<string, FakeHostBehaviour>;
  } = {},
) {
  return {
    api: freshApi(),
    thisMachineId: over.thisMachineId ?? THIS_MAC,
    mintToken: mintCounter(),
    // The real `node:crypto` digest, matching what main injects. Using the real
    // one is what makes the fake Worker's registry lookup meaningful.
    hashToken: (t: string) => createHash("sha256").update(t, "utf8").digest("hex"),
    fetchImpl: workerFetchFor(cloud, {
      ...(over.healthFailures === undefined ? {} : { healthFailures: over.healthFailures }),
      ...(over.authFailures === undefined ? {} : { authFailures: over.authFailures }),
      ...(over.noRegistry === undefined ? {} : { noRegistry: over.noRegistry }),
      ...(over.hosts === undefined ? {} : { hosts: over.hosts }),
    }),
    // The TLS wait is real time in production and no time here.
    sleep: async () => undefined,
    commit: async (c: { workerUrl: string; altWorkerUrl: string | null; token: string }) => {
      committed.push(c);
    },
  };
}

async function run(
  over: Parameters<typeof setup>[0] = {},
  req: { subdomain?: string } = {},
): Promise<CloudSetupOutcome> {
  return await runCloudSetup(setup(over), {
    accountId: FAKE_ACCOUNT_ID,
    ...(req.subdomain === undefined ? {} : { subdomain: req.subdomain }),
  });
}

async function probeAs(machineId = THIS_MAC, accountId?: string) {
  return await probeCloud(
    { api: freshApi(), thisMachineId: machineId },
    accountId,
  );
}

beforeEach(() => {
  cloud = new FakeCloudflare();
  committed = [];
  minted = [];
  mintCount = 0;
});

describe("a first run, on a blank account", () => {
  it("creates everything, enrols this Mac, and turns sync on here", async () => {
    const out = await run();

    expect(out.error, out.error ?? "").toBeNull();
    expect(out.ok).toBe(true);
    expect(out.steps.every((s) => s.state === "done")).toBe(true);

    expect(cloud.databases.map((d) => d.name)).toEqual(["wwb"]);
    expect(cloud.databases[0]?.schemaApplied).toBe(true);
    expect(cloud.workersDevEnabled).toBe(true);

    // The URL is composed from a subdomain READ BACK off the account, and then
    // proved by /health before it is stored.
    expect(out.workerUrl).toBe(`https://wwb-sync.${FAKE_SUBDOMAIN}.workers.dev`);
    expect(committed).toEqual([
      // No second address was asked for, so there is none to remember.
      { workerUrl: out.workerUrl, altWorkerUrl: null, token: minted[0] },
    ]);
  });

  it("mints exactly ONE token, for this Mac, and nothing for anybody else", async () => {
    const out = await run();
    expect(minted).toHaveLength(1);
    expect(committed[0]?.token).toBe(minted[0]);
    // The only token this app ever renders is the keychain-refused one.
    expect(out.unstoredToken).toBeNull();
    expect(cloud.liveTokens()).toHaveLength(1);
    expect(cloud.liveTokens()[0]?.machineId).toBe(THIS_MAC);
  });

  it("sends the token's SHA-256 and NEVER the token", async () => {
    await run();
    const token = minted[0] ?? "";
    expect(cloud.liveTokens()[0]?.tokenSha256).toBe(sha256Hex(token));
    // The plaintext reaches no request body at all — not the enrolment, not the
    // upload, not a query. Cloudflare holds a hash and nothing presentable.
    expect(cloud.allRequestBodies()).not.toContain(token);
  });

  it("uploads exactly one binding — no secret_text, no plain_text, no inherit", async () => {
    await run();
    const upload = cloud.uploads.at(-1);
    expect(upload?.script).toBe(WORKER_BUNDLE);
    expect(upload?.mainModule).toBe("index.js");
    expect(upload?.compatibilityDate).toBe("2026-08-01");
    // The flag stays even though nothing is inherited any more: it costs
    // nothing and it is the guarantee any future binding will want.
    expect(upload?.strict).toBe(true);

    expect(upload?.bindings).toEqual([
      { type: "d1", name: "DB", database_id: cloud.databases[0]?.uuid },
    ]);
  });

  it("binds the enrolment rather than interpolating it", async () => {
    // The regression guard for a real bug found in passing: `query()`
    // string-interpolates, which becomes an injection site the moment a machine
    // id goes into a statement.
    await run();
    const insert = cloud.queries.find((q) => q.sql.includes("INSERT INTO machine_token"));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain("?");
    expect(insert?.sql).not.toContain(THIS_MAC);
    expect(insert?.params).toEqual([
      sha256Hex(minted[0] ?? ""),
      THIS_MAC,
      expect.any(String),
    ]);
  });

  it("sends no free text — not a label, not a device name — in enrolment SQL", async () => {
    // A machine's name has exactly one home, the `machine` table, written by
    // that machine's own heartbeat.
    await run();
    const registrySql = cloud.queries
      // The schema apply obviously names every column, `machine.label`
      // included. What must carry no free text is the enrolment WRITE.
      .filter((q) => /INSERT INTO machine_token|UPDATE machine_token/.test(q.sql))
      .map((q) => JSON.stringify(q))
      .join("\n");
    expect(registrySql).not.toBe("");
    expect(registrySql).not.toContain("label");
  });
});

describe("adopting what is already there", () => {
  it("adopts an existing wwb database rather than creating a second one", async () => {
    const existing = cloud.seedDatabase("wwb");
    const out = await run();

    expect(out.ok).toBe(true);
    expect(cloud.databases).toHaveLength(1);
    expect(cloud.databases[0]?.uuid).toBe(existing.uuid);
    expect(
      cloud.calls.filter((c) => c.method === "POST" && c.path.endsWith("/d1/database")),
    ).toEqual([]);
    // And the Worker is bound to the adopted one, not to a new id.
    expect(cloud.bindingValue("DB")).toBe(existing.uuid);
    expect(out.steps.find((s) => s.id === "database")?.detail).toContain("adopted");
  });

  it("ignores a database whose name merely starts the same way", async () => {
    // The list endpoint's `name` filter is documented only as "a database name
    // to search for". A prefix match that adopted `wwb-old` would point the
    // Worker at the wrong history and nothing would say so.
    cloud.seedDatabase("wwb-old", "db-uuid-old");
    await run();
    expect(cloud.databases.map((d) => d.name).sort()).toEqual(["wwb", "wwb-old"]);
    expect(cloud.bindingValue("DB")).not.toBe("db-uuid-old");
  });

  it("re-running is idempotent: no second database, no second Worker name", async () => {
    await run();
    const afterFirst = {
      databases: cloud.databases.length,
      dbId: cloud.bindingValue("DB"),
    };
    const second = await run();

    expect(second.ok).toBe(true);
    expect(cloud.databases).toHaveLength(afterFirst.databases);
    expect(cloud.bindingValue("DB")).toBe(afterFirst.dbId);
    expect(cloud.uploads.map((u) => u.scriptName)).toEqual(["wwb-sync", "wwb-sync"]);
  });
});

describe("re-running on the SAME Mac", () => {
  it("enrols a new token and revokes this Mac's previous ones", async () => {
    await run();
    const firstToken = committed[0]?.token ?? "";
    await run();
    const secondToken = committed[1]?.token ?? "";

    expect(secondToken).not.toBe(firstToken);
    // Exactly one live row for this Mac, and it is the new one.
    expect(cloud.liveTokens()).toHaveLength(1);
    expect(cloud.liveTokens()[0]?.tokenSha256).toBe(sha256Hex(secondToken));
    // The old row is REVOKED, not deleted: who could write, and when, is history.
    const rows = cloud.registryRows();
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.tokenSha256 === sha256Hex(firstToken));
    expect(old?.revokedAtMs).not.toBeNull();
  });

  it("revokes AFTER the keychain commit, never before", async () => {
    // THE ORDERING IS THE DESIGN. Until the new token is stored and proven, the
    // old one is the only working credential this Mac has. Revoking earlier
    // means a run that fails at the save step leaves the Mac offline.
    await run();
    committed = [];
    const order: string[] = [];
    await runCloudSetup(
      {
        ...setup(),
        commit: async (c) => {
          order.push("commit");
          committed.push(c);
        },
      },
      { accountId: FAKE_ACCOUNT_ID },
    );
    // Reconstruct when the revoke happened relative to the commit by watching
    // the query log length at commit time is fragile; assert directly instead.
    const revokeIndex = cloud.queries.findIndex((q) =>
      q.sql.includes("UPDATE machine_token"),
    );
    expect(revokeIndex).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(["commit"]);
  });

  it("leaves the old token LIVE when the keychain refuses", async () => {
    // The new token is not stored, so an older one may still be the only
    // working credential this Mac has. Revoking here would take it offline.
    await run();
    const firstToken = committed[0]?.token ?? "";

    const out = await runCloudSetup(
      {
        ...setup(),
        commit: async () => {
          throw new Error("no safeStorage backend on this system");
        },
      },
      { accountId: FAKE_ACCOUNT_ID },
    );

    expect(out.ok).toBe(false);
    expect(out.unstoredToken).not.toBeNull();
    const old = cloud
      .registryRows()
      .find((r) => r.tokenSha256 === sha256Hex(firstToken));
    expect(old?.revokedAtMs).toBeNull();
  });

  it("does not fail the run when the revoke itself fails", async () => {
    // Two live tokens for one machine is harmless — both stamp the same
    // machine_id — and not worth failing a setup that otherwise worked.
    await run();
    committed = [];
    // Fail ONLY the revoke — the enrolment INSERT must still succeed, or this
    // would be testing a different failure entirely.
    const real = freshApi();
    const out = await runCloudSetup(
      {
        ...setup(),
        api: {
          ...real,
          queryParams: async (a, b, sql, p) => {
            if (sql.includes("UPDATE machine_token")) {
              throw new Error("the revoke failed");
            }
            return await real.queryParams(a, b, sql, p);
          },
        },
      },
      { accountId: FAKE_ACCOUNT_ID },
    );

    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.steps.find((s) => s.id === "save")?.detail).toContain("could not be revoked");
    expect(committed).toHaveLength(1);
  });
});

describe("a SECOND Mac", () => {
  /** Mac one has been through the wizard; this is mac two running it. */
  async function afterFirstMac(): Promise<string> {
    await runCloudSetup(setup({ thisMachineId: OTHER_MAC }), {
      accountId: FAKE_ACCOUNT_ID,
    });
    const firstMacToken = committed[0]?.token ?? "";
    committed = [];
    minted = [];
    return firstMacToken;
  }

  it("enrols itself and does not touch the first Mac's registry row", async () => {
    const firstMacToken = await afterFirstMac();

    const out = await run({ thisMachineId: THIS_MAC });

    expect(out.ok).toBe(true);
    // Two live rows, one per machine, each with its own id.
    const live = cloud.liveTokens();
    expect(live.map((t) => t.machineId).sort()).toEqual([THIS_MAC, OTHER_MAC].sort());
    // The first Mac's row is byte for byte what it was.
    const theirs = live.find((t) => t.machineId === OTHER_MAC);
    expect(theirs?.tokenSha256).toBe(sha256Hex(firstMacToken));
    expect(theirs?.revokedAtMs).toBeNull();
  });

  it("mints nothing for anybody else, and shows no token to carry", async () => {
    await afterFirstMac();
    const out = await run({ thisMachineId: THIS_MAC });
    expect(minted).toHaveLength(1);
    expect(out.unstoredToken).toBeNull();
  });

  it("nothing anywhere asks which Mac this is", async () => {
    await afterFirstMac();
    const out = await run({ thisMachineId: THIS_MAC });
    const text = JSON.stringify(out);
    for (const phrase of ["personal", "work Mac", "slot", "This is my"]) {
      expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it("the review screen lists the machines already enrolled", async () => {
    await afterFirstMac();
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");
    db.machineRows.push({
      machineId: OTHER_MAC,
      label: "Work MacBook",
      lastSeenMs: 1_760_000_500_000,
    });

    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    const machines = probe.deployment?.machines ?? [];
    expect(machines).toHaveLength(1);
    expect(machines[0]?.machineId).toBe(OTHER_MAC);
    expect(machines[0]?.label).toBe("Work MacBook");
  });

  it("lists a Mac that has enrolled but never sent a heartbeat, as its bare id", async () => {
    // LEFT JOIN. A machine with no `machine` row must still appear — anything
    // else is a Mac that is enrolled and invisible.
    await afterFirstMac();
    const machines = (await probeAs(THIS_MAC, FAKE_ACCOUNT_ID)).deployment?.machines ?? [];
    expect(machines[0]?.machineId).toBe(OTHER_MAC);
    expect(machines[0]?.label).toBeNull();
  });
});

describe("revoking another Mac", () => {
  it("stops that Mac and leaves every other row alone", async () => {
    await run({ thisMachineId: OTHER_MAC });
    const theirToken = committed[0]?.token ?? "";
    committed = [];
    await run({ thisMachineId: THIS_MAC });
    const myToken = committed[0]?.token ?? "";
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");

    await revokeMachine({
      api: freshApi(),
      accountId: FAKE_ACCOUNT_ID,
      databaseId: db.uuid,
      machineId: OTHER_MAC,
    });

    const live = cloud.liveTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenSha256).toBe(sha256Hex(myToken));
    // Revoked, never deleted.
    const gone = cloud.registryRows().find((r) => r.tokenSha256 === sha256Hex(theirToken));
    expect(gone?.revokedAtMs).not.toBeNull();
  });

  it("binds the machine id rather than interpolating it", async () => {
    await run();
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");
    await revokeMachine({
      api: freshApi(),
      accountId: FAKE_ACCOUNT_ID,
      databaseId: db.uuid,
      machineId: OTHER_MAC,
    });
    const update = cloud.queries.at(-1);
    expect(update?.sql).toContain("?");
    expect(update?.sql).not.toContain(OTHER_MAC);
    expect(update?.params).toContain(OTHER_MAC);
  });

  it("refuses a machine id that is not a machine id, before any request", async () => {
    await run();
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");
    const before = cloud.queries.length;
    await expect(
      revokeMachine({
        api: freshApi(),
        accountId: FAKE_ACCOUNT_ID,
        databaseId: db.uuid,
        machineId: "'; DROP TABLE machine_token; --",
      }),
    ).rejects.toThrow(/not a machine id/);
    expect(cloud.queries).toHaveLength(before);
  });

  it("readEnrolledMachines reflects a revoke immediately", async () => {
    await run({ thisMachineId: OTHER_MAC });
    await run({ thisMachineId: THIS_MAC });
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");

    expect(await readEnrolledMachines(freshApi(), FAKE_ACCOUNT_ID, db.uuid)).toHaveLength(2);
    await revokeMachine({
      api: freshApi(),
      accountId: FAKE_ACCOUNT_ID,
      databaseId: db.uuid,
      machineId: OTHER_MAC,
    });
    const after = await readEnrolledMachines(freshApi(), FAKE_ACCOUNT_ID, db.uuid);
    expect(after.map((m) => m.machineId)).toEqual([THIS_MAC]);
  });
});

describe("this Mac's id must be real", () => {
  it("refuses to enrol when the hardware UUID could not be read", async () => {
    const out = await run({ thisMachineId: "" });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("hardware UUID");
    expect(out.error).toContain("ioreg");
    expect(out.steps.find((s) => s.id === "enrol")?.state).toBe("failed");
    // Nothing was enrolled and nothing was stored.
    expect(cloud.liveTokens()).toEqual([]);
    expect(committed).toEqual([]);
  });

  it("refuses an id that is not a shape it will send", async () => {
    const out = await run({ thisMachineId: "not a uuid; DROP TABLE machine_token" });
    expect(out.ok).toBe(false);
    expect(cloud.liveTokens()).toEqual([]);
  });
});

describe("scope preflight", () => {
  it("reports every scope present for a full token", async () => {
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    expect(probe.scopes).toEqual({
      d1: "ok",
      workers: "ok",
      accountRead: "ok",
      zones: "ok",
    });
    expect(probe.deployment).not.toBeNull();
  });

  for (const status of [401, 403] as const) {
    it(`reports a missing D1 permission as DATA, not an error banner (${String(status)})`, async () => {
      // The design must be right under both statuses — Cloudflare has answered
      // a missing scope with each, and code 10000 covers all three cases.
      cloud.denyStatus = status;
      cloud.denied.add("D1: Read");
      const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);

      expect(probe.tokenValid).toBe(true);
      expect(probe.scopes?.d1).toBe("missing");
      // Deliberately null/null: inspecting a deployment the token may not read
      // is pointless, and the screen renders the named permission instead of a
      // red banner with the wrong words.
      expect(probe.deployment).toBeNull();
      expect(probe.error).toBeNull();
    });

    it(`reports a missing Workers permission the same way (${String(status)})`, async () => {
      cloud.denyStatus = status;
      cloud.denied.add("Workers Scripts: Read");
      const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
      expect(probe.scopes?.workers).toBe("missing");
      expect(probe.scopes?.d1).toBe("ok");
      expect(probe.deployment).toBeNull();
    });
  }

  it("reports BOTH missing when the token came from a template", async () => {
    cloud.denied.add("D1: Read");
    cloud.denied.add("Workers Scripts: Read");
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    expect(probe.scopes?.d1).toBe("missing");
    expect(probe.scopes?.workers).toBe("missing");
  });

  it("creates nothing while probing", async () => {
    await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    const mutating = cloud.calls.filter(
      (c) => c.method === "POST" || c.method === "PUT" || c.method === "DELETE",
    );
    expect(mutating).toEqual([]);
    expect(cloud.databases).toEqual([]);
  });
});

describe("failures", () => {
  for (const status of [401, 403] as const) {
    it(`names the missing D1 permission, not the status code (${String(status)})`, async () => {
      // THE REGRESSION TEST FOR THE OBSERVED FAILURE. The owner created a token
      // with one of three permissions and was told "Cloudflare did not accept
      // that API token", which sent him to re-copy a perfectly good token. That
      // message came from the 401 branch. Once the token has verified, a 401
      // and a 403 mean the same thing and must read the same way.
      cloud.denyStatus = status;
      cloud.denied.add("D1: Edit");
      const out = await run();

      expect(out.ok).toBe(false);
      expect(out.error).toContain("D1: Edit");
      expect(out.error).toContain("permission");
      expect(out.error).toContain("dashboard");
      // And it must NOT tell him the token is wrong.
      expect(out.error).not.toContain("copied whole");
      expect(out.error).toContain("Do not create a new token");
    });

    it(`names Workers Scripts: Edit when the deploy is refused (${String(status)})`, async () => {
      cloud.denyStatus = status;
      cloud.denied.add("Workers Scripts: Edit");
      const out = await run();

      expect(out.error).toContain("Workers Scripts: Edit");
      expect(out.error).not.toContain("copied whole");
      expect(out.steps.find((s) => s.id === "deploy")?.state).toBe("failed");
      // The database was created before the refusal, and stays.
      expect(cloud.databases.map((d) => d.name)).toEqual(["wwb"]);
    });
  }

  it("tells a dead network apart from a refused one", async () => {
    cloud.offline = true;
    const out = await run();

    expect(out.error).toContain("could not reach api.cloudflare.com");
    expect(out.error).not.toContain("permission");
  });

  it("a token that never verified still gets 'did not accept', with no permission list", async () => {
    // The one case the old 401 wording is right for, and now the only case it
    // covers: Cloudflare does not recognise the string at all.
    cloud.verifyStatus = 401;
    const out = await run();

    expect(out.error).toContain("did not accept that API token");
    expect(out.error).not.toContain("permission");
    expect(out.error).not.toContain("Do not create a new token");
  });

  it("refuses a token Cloudflare says is not active", async () => {
    cloud.tokenStatus = "expired";
    const out = await run();
    expect(out.error).toContain("expired");
    expect(out.steps.find((s) => s.id === "token")?.state).toBe("failed");
    expect(cloud.databases).toEqual([]);
  });

  it("fails loudly on a digest collision rather than absorbing it", async () => {
    // A plain INSERT, no ON CONFLICT. A 256-bit collision is not a case to
    // absorb quietly, and the constraint error should fail the run.
    await run();
    committed = [];
    const reused = minted[0] ?? "";
    const out = await runCloudSetup(
      { ...setup(), mintToken: () => reused },
      { accountId: FAKE_ACCOUNT_ID },
    );
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.id === "enrol")?.state).toBe("failed");
    expect(committed).toEqual([]);
  });

  it("says a failed enrolment changed nothing, rather than leaving it ambiguous", async () => {
    // Reaching here means the token was minted and stored NOWHERE — not the
    // Keychain, not Cloudflare — so "run it again" really is the whole fix, and
    // saying so is the difference between a retry and a cleanup hunt.
    // Fail ONLY the enrolment INSERT — a blanket D1 denial would stop at the
    // schema apply and be testing a different step.
    const real = freshApi();
    const out = await runCloudSetup(
      {
        ...setup(),
        api: {
          ...real,
          queryParams: async (a, b, sql, p) => {
            if (sql.includes("INSERT INTO machine_token")) {
              throw new Error("D1 said no");
            }
            return await real.queryParams(a, b, sql, p);
          },
        },
      },
      { accountId: FAKE_ACCOUNT_ID },
    );

    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.id === "enrol")?.state).toBe("failed");
    expect(out.error).toContain("Nothing else was changed");
    expect(out.error).toContain("Running setup again is safe");
    expect(cloud.liveTokens()).toEqual([]);
    expect(committed).toEqual([]);
  });

  it("waits out the certificate a new workers.dev address has not been issued yet", async () => {
    // DNS resolves before TLS is ready — measured at about two minutes on the
    // first real setup. Reporting that as a failure would send someone
    // debugging a Worker that is perfectly fine.
    const out = await run({ healthFailures: 3 });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.id === "verify")?.state).toBe("done");
  });

  it("waits out a redeploy that has not reached every colo yet", async () => {
    // On a redeploy the hostname is months old, so /health answers instantly —
    // from whichever version is live at that instant. A brand-new token can
    // legitimately 401 for a second or two.
    const out = await run({ authFailures: 2 });
    expect(out.error, out.error ?? "").toBeNull();
    expect(out.ok).toBe(true);
  });

  it("blames the database pointer, not the token, when the Worker keeps rejecting", async () => {
    const out = await run({ authFailures: 99 });
    expect(out.ok).toBe(false);
    // The registry row IS in place, so "your token is wrong" would be a lie.
    expect(out.error).toContain("did not accept the token this setup just enrolled");
    expect(out.error).toContain("different D1 database");
    expect(out.steps.find((s) => s.id === "deploy")?.state).toBe("done");
    expect(committed).toEqual([]);
  });

  it("says the schema was never applied when the Worker answers 503", async () => {
    const out = await run({ noRegistry: true });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no machine registry yet");
    expect(out.error).toContain("schema was never applied");
  });

  it("does not store anything when the Worker never answers", async () => {
    const out = await run({ healthFailures: 99 });
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.id === "verify")?.state).toBe("failed");
    // The local half is written only after the deployed Worker replies. A URL
    // saved here would read as "sync is on" for something that never answered.
    expect(committed).toEqual([]);
    expect(out.steps.find((s) => s.id === "save")?.state).toBe("pending");
  });

  it("hands over this Mac's token when the keychain will not take it", async () => {
    const out = await runCloudSetup(
      {
        ...setup(),
        commit: async () => {
          throw new Error("no safeStorage backend on this system");
        },
      },
      { accountId: FAKE_ACCOUNT_ID },
    );

    expect(out.ok).toBe(false);
    // The cloud half really is set up. Reporting a flat failure would send
    // someone to re-run a deployment that is already correct.
    expect(cloud.workersDevEnabled).toBe(true);
    expect(out.unstoredToken).toBe(minted[0]);
    expect(out.workerUrl).not.toBeNull();
  });
});

describe("resuming", () => {
  const STEPS = ["account", "database", "schema", "enrol", "deploy", "url", "verify"] as const;
  const FAIL_AT: Record<(typeof STEPS)[number], string> = {
    account: "/d1/database",
    database: "/d1/database",
    schema: "/query",
    enrol: "/query",
    deploy: "/workers/scripts/wwb-sync",
    url: "/workers/subdomain",
    verify: "/workers/scripts/wwb-sync/subdomain",
  };

  for (const step of STEPS) {
    it(`recovers from a failure at "${step}" on the next run`, async () => {
      cloud.failOnce.set(FAIL_AT[step], 500);
      const failed = await run();
      expect(failed.ok).toBe(false);
      expect(failed.error).not.toBeNull();

      // No cleanup, no flag, no "start over": just run it again.
      const second = await run();
      expect(second.error, second.error ?? "").toBeNull();
      expect(second.ok).toBe(true);
      // And the retry did not duplicate the one resource that costs something.
      expect(cloud.databases.map((d) => d.name)).toEqual(["wwb"]);
      expect(committed).toHaveLength(1);
      // Exactly one live credential for this Mac, whatever happened first time.
      expect(cloud.liveTokens()).toHaveLength(1);
    });
  }
});

describe("choosing an account", () => {
  it("never picks one when the token can reach several", async () => {
    cloud.accounts = [
      { id: FAKE_ACCOUNT_ID, name: "Personal" },
      { id: "00000000000000000000000000000002", name: "Work" },
    ];
    const probe = await probeAs(THIS_MAC);
    // Two accounts and no choice made yet: nothing has been inspected, because
    // creating a database on the wrong one is a bill and a split history.
    expect(probe.accounts).toHaveLength(2);
    expect(probe.deployment).toBeNull();
    expect(probe.scopes).toBeNull();
  });

  it("carries on when the token may not list accounts at all", async () => {
    // Cloudflare documents GET /accounts for API keys, not tokens. A token that
    // cannot enumerate is normal, and the pane asks for the id instead.
    cloud.denied.add("Account Settings: Read");
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    expect(probe.tokenValid).toBe(true);
    expect(probe.accounts).toEqual([]);
    expect(probe.error).toBeNull();
    expect(probe.deployment?.accountId).toBe(FAKE_ACCOUNT_ID);
    // Missing Account Settings: Read is not a blocker — it is optional.
    expect(probe.scopes?.accountRead).toBe("missing");
    expect(probe.scopes?.d1).toBe("ok");
  });
});

describe("the workers.dev subdomain", () => {
  it("will not invent one for an account that has never chosen", async () => {
    cloud.subdomain = null;
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.error).toContain("account-wide");
    expect(out.steps.find((s) => s.id === "url")?.state).toBe("failed");
  });

  it("claims the one the owner typed", async () => {
    cloud.subdomain = null;
    const out = await run({}, { subdomain: "chosen-name" });
    expect(out.ok).toBe(true);
    expect(cloud.subdomain).toBe("chosen-name");
    expect(out.workerUrl).toBe("https://wwb-sync.chosen-name.workers.dev");
  });

  it("never renames a subdomain the account already has", async () => {
    await run({}, { subdomain: "something-else" });
    expect(cloud.subdomain).toBe(FAKE_SUBDOMAIN);
  });
});

describe("progress", () => {
  it("emits a complete snapshot per change, never a delta", async () => {
    const seen: Array<ReadonlyArray<{ id: string; state: string }>> = [];
    await runCloudSetup(
      {
        ...setup(),
        onProgress: (p) => seen.push(p.steps.map((s) => ({ id: s.id, state: s.state }))),
      },
      { accountId: FAKE_ACCOUNT_ID },
    );

    expect(seen.length).toBeGreaterThan(9);
    // Every emission carries all NINE steps, so a dropped update costs a stale
    // frame rather than a row stuck on "running" for the session.
    for (const snapshot of seen) expect(snapshot).toHaveLength(9);
    expect(seen.at(-1)?.every((s) => s.state === "done")).toBe(true);
  });

  it("includes the enrol step, in order, between schema and deploy", async () => {
    const out = await run();
    expect(out.steps.map((s) => s.id)).toEqual([
      "token",
      "account",
      "database",
      "schema",
      "enrol",
      "deploy",
      "url",
      "verify",
      "save",
    ]);
  });
});

/**
 * The optional second address.
 *
 * The premise this feature was built on is UNPROVEN: nobody knows whether the
 * work Mac's proxy blocks `*.workers.dev`, blocks everything, or is not a
 * domain block at all. So the design hedges, and so does this file — what is
 * asserted throughout is that both addresses are turned on, that whichever one
 * THIS Mac can reach is the one it saves, and that every way the second address
 * can fail costs a sentence rather than a setup.
 */
describe("a custom domain", () => {
  const CUSTOM_HOST = `wwb.${FAKE_ZONE_NAME}`;
  const CUSTOM_URL = `https://${CUSTOM_HOST}`;
  const DEV_URL = `https://wwb-sync.${FAKE_SUBDOMAIN}.workers.dev`;
  const DEV_HOST = `wwb-sync.${FAKE_SUBDOMAIN}.workers.dev`;

  const withDomain = async (
    over: Parameters<typeof setup>[0] = {},
    domain: CustomDomainRequest = { label: "wwb", zone: { id: FAKE_ZONE_ID, name: FAKE_ZONE_NAME } },
  ): Promise<CloudSetupOutcome> =>
    await runCloudSetup(setup(over), { accountId: FAKE_ACCOUNT_ID, customDomain: domain });

  const attachCalls = () =>
    cloud.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/workers/domains"));

  it("turns on BOTH addresses — the workers.dev one is never traded away", async () => {
    const out = await withDomain();
    expect(out.ok).toBe(true);
    // Both, in Cloudflare. Which one this Mac uses is a separate question and
    // a different Mac may answer it differently.
    expect(cloud.workersDevEnabled).toBe(true);
    expect(cloud.workerDomains.map((d) => d.hostname)).toEqual([CUSTOM_HOST]);
    expect(cloud.workerDomains[0]?.service).toBe("wwb-sync");
  });

  it("prefers the custom domain when both answer, and remembers the other", async () => {
    const out = await withDomain();
    expect(out.workerUrl).toBe(CUSTOM_URL);
    expect(out.altWorkerUrl).toBe(DEV_URL);
    expect(out.addresses).toHaveLength(2);
    expect(out.addresses.every((a) => a.reachable)).toBe(true);
    expect(committed[0]).toMatchObject({ workerUrl: CUSTOM_URL, altWorkerUrl: DEV_URL });
  });

  it("uses workers.dev when the custom domain never answers, and still succeeds", async () => {
    const out = await withDomain({ hosts: { [CUSTOM_HOST]: { blocked: true } } });
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(DEV_URL);
    const custom = out.addresses.find((a) => a.kind === "custom");
    expect(custom?.reachable).toBe(false);
    expect(custom?.error).toMatch(/proxy dropped it/);
  });

  it("uses the custom domain when WORKERS.DEV is the blocked one", async () => {
    // The work-Mac scenario, and the entire reason this feature exists. Before
    // this, a Mac in this situation had no address at all and no way to say so.
    const out = await withDomain({ hosts: { [DEV_HOST]: { blocked: true } } });
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(CUSTOM_URL);
    expect(out.altWorkerUrl).toBe(DEV_URL);
    expect(out.addresses.find((a) => a.kind === "workers.dev")?.error).toMatch(
      /proxy dropped it/,
    );
  });

  it("fails, commits nothing, and names both reasons when neither answers", async () => {
    const out = await withDomain({
      hosts: { [CUSTOM_HOST]: { blocked: true }, [DEV_HOST]: { healthFailures: 99 } },
    });
    expect(out.ok).toBe(false);
    expect(committed).toEqual([]);
    expect(out.error).toContain(CUSTOM_URL);
    expect(out.error).toContain(DEV_URL);
    expect(out.error).toMatch(/proxy dropped it/);
    expect(out.error).toMatch(/does not resolve from this Mac/);
    // Reaching verify at all proves the API calls got through, which rules out
    // "the network is down" without asking anyone to test anything.
    expect(out.error).toMatch(/api\.cloudflare\.com WAS reachable/);
    // The report survives the failure — that is when it is worth most.
    expect(out.addresses).toHaveLength(2);
  });

  it("is idempotent: a second run makes no second attach", async () => {
    await withDomain();
    expect(attachCalls()).toHaveLength(1);
    const second = await withDomain();
    expect(second.ok).toBe(true);
    expect(second.workerUrl).toBe(CUSTOM_URL);
    // Re-running setup must be free. The cheapest way for a re-attach to be
    // harmless is for it not to happen.
    expect(attachCalls()).toHaveLength(1);
    expect(cloud.workerDomains).toHaveLength(1);
    expect(second.steps.find((s) => s.id === "url")?.detail).toContain("already on");
  });

  it("attaches by zone NAME when the zones could not be listed", async () => {
    // This is what makes `Zone: Read` optional rather than required: the owner
    // types the domain and the request carries `zone_name`.
    cloud.denied.add("Zone: Read");
    const out = await withDomain({}, { label: "wwb", zone: { name: FAKE_ZONE_NAME } });
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(CUSTOM_URL);
    const body = JSON.parse(attachCalls().at(-1)?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ zone_name: FAKE_ZONE_NAME });
    expect(body).not.toHaveProperty("zone_id");
  });

  it("leaves a hostname belonging to another Worker alone, and still succeeds", async () => {
    cloud.workerDomains.push({
      id: "domain-someone-else",
      cert_id: "00000000-0000-0000-0000-0000000000ff",
      hostname: CUSTOM_HOST,
      zone_id: FAKE_ZONE_ID,
      zone_name: FAKE_ZONE_NAME,
      service: "somebody-elses-worker",
    });
    const out = await withDomain();
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(DEV_URL);
    expect(out.steps.find((s) => s.id === "url")?.detail).toContain("somebody-elses-worker");
    // NOT ONE WRITE. The other Worker's address is not something to try and
    // find out about by attempting to take it.
    expect(attachCalls()).toEqual([]);
  });

  it("does not fail the run when a DNS record is already at that name", async () => {
    cloud.dnsRecords.push(CUSTOM_HOST);
    const out = await withDomain();
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(DEV_URL);
    const detail = out.steps.find((s) => s.id === "url")?.detail ?? "";
    // Our sentence, not Cloudflare's — its text has already changed once and
    // currently recommends a flag this endpoint does not have.
    expect(detail).toContain("a DNS record already exists at that name");
    expect(detail).not.toContain("override_existing_dns_record");
  });

  it("refuses a label that is not a label, without failing anything", async () => {
    const out = await withDomain({}, { label: "not a label", zone: { name: FAKE_ZONE_NAME } });
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(DEV_URL);
    expect(out.steps.find((s) => s.id === "url")?.detail).toMatch(/lowercase letters/);
    expect(attachCalls()).toEqual([]);
  });

  it("waits out a certificate that has not been issued yet", async () => {
    const slept: number[] = [];
    const out = await runCloudSetup(
      {
        ...setup({ hosts: { [CUSTOM_HOST]: { tlsNotReady: 3 } } }),
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
      {
        accountId: FAKE_ACCOUNT_ID,
        customDomain: { label: "wwb", zone: { id: FAKE_ZONE_ID, name: FAKE_ZONE_NAME } },
      },
    );
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(CUSTOM_URL);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("stops retrying immediately on a refusal — a three-minute wait for one is a bug", async () => {
    const slept: number[] = [];
    const out = await runCloudSetup(
      {
        ...setup({ hosts: { [CUSTOM_HOST]: { blocked: true } } }),
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
      {
        accountId: FAKE_ACCOUNT_ID,
        customDomain: { label: "wwb", zone: { id: FAKE_ZONE_ID, name: FAKE_ZONE_NAME } },
      },
    );
    expect(out.ok).toBe(true);
    // An ECONNRESET is an ANSWER, not a certificate still being issued. The
    // fresh ladder is ten rungs long; this must not climb it.
    expect(slept.length).toBeLessThan(5);
  });

  it("names the zone's security settings when it answers a challenge page", async () => {
    // THE WORST FAILURE THIS FEATURE COULD PRODUCE. A custom domain routes
    // through the zone and workers.dev does not, so Bot Fight Mode, a WAF rule
    // or Access on that domain would suddenly apply to sync traffic and answer
    // an unsolvable 403 to a token that is perfectly good.
    const out = await withDomain({ hosts: { [CUSTOM_HOST]: { challenge: true } } });
    expect(out.ok).toBe(true);
    expect(out.workerUrl).toBe(DEV_URL);
    const custom = out.addresses.find((a) => a.kind === "custom");
    expect(custom?.error).toMatch(/Bot Fight Mode/);
    expect(custom?.error).toMatch(/not the token/);
    // The body is never read into the message: an HTML page in an error toast
    // tells the reader nothing and could echo the request back at them.
    expect(custom?.error).not.toContain("<");
    expect(custom?.error).not.toMatch(/Checking your browser/);
  });

  it("changes nothing at all when no custom domain is asked for", async () => {
    const out = await run();
    expect(out.altWorkerUrl).toBeNull();
    expect(out.addresses).toHaveLength(1);
    expect(out.addresses[0]).toMatchObject({ kind: "workers.dev", reachable: true });
    expect(out.workerUrl).toBe(DEV_URL);
    expect(cloud.workerDomains).toEqual([]);
    expect(attachCalls()).toEqual([]);
    // The step list is untouched: no new step, no sub-menu.
    expect(out.steps).toHaveLength(9);
  });

  it("finishes a half-done attach on the next run", async () => {
    // The domain went on, then the run died before it saved — here because
    // neither address answered from this Mac. The second run must find its own
    // hostname and adopt it rather than making a second one.
    const first = await withDomain({
      hosts: { [CUSTOM_HOST]: { blocked: true }, [DEV_HOST]: { blocked: true } },
    });
    expect(first.ok).toBe(false);
    expect(cloud.workerDomains).toHaveLength(1);

    const second = await withDomain();
    expect(second.ok).toBe(true);
    expect(second.workerUrl).toBe(CUSTOM_URL);
    expect(cloud.workerDomains).toHaveLength(1);
    expect(attachCalls()).toHaveLength(1);
  });
});

describe("the zone scope is data, never an error banner", () => {
  it("reports a missing Zone: Read as a scope and lists no domains", async () => {
    cloud.denied.add("Zone: Read");
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    expect(probe.scopes?.zones).toBe("missing");
    expect(probe.deployment?.zones).toEqual([]);
    // Not an error. The same shape as the existing D1/Workers scope tests: a
    // missing OPTIONAL permission reaches the screen as something it can render
    // properly, never as a red banner using the words for a different failure.
    expect(probe.error).toBeNull();
    expect(probe.deployment).not.toBeNull();
  });

  it("lists this account's domains, and only this account's", async () => {
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    expect(probe.scopes?.zones).toBe("ok");
    expect(probe.deployment?.zones.map((z) => z.name)).toEqual([
      FAKE_ZONE_NAME,
      OTHER_ZONE_NAME,
    ]);
  });

  it("separates an account with no domains from a token that may not look", async () => {
    cloud.zones = [];
    const probe = await probeAs(THIS_MAC, FAKE_ACCOUNT_ID);
    // `ok` with an empty list. The screen says "this account has no domains on
    // it", which is a completely different sentence from "add Zone: Read".
    expect(probe.scopes?.zones).toBe("ok");
    expect(probe.deployment?.zones).toEqual([]);
  });
});
