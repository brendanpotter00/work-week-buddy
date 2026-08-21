/**
 * In-app cloud setup, against a fake Cloudflare.
 *
 * `scripts/bringup-cloud.sh` is the specification and `test/scripts/
 * bringup-cloud.test.ts` already proves the shell version. This proves the same
 * properties of the app version, and they are all about the SECOND run:
 *
 *   * an existing `wwb` database is ADOPTED, never duplicated
 *   * the other Mac's token survives — it cannot be read back, so an upload
 *     that forgot it would take that Mac offline with no error anywhere
 *   * the second Mac sets only its own slot
 *   * a failure at any step leaves a world the next run can pick up
 *
 * The account, the tokens and the ids in here are all obvious nonsense, and
 * nothing in this file touches a real Cloudflare account.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createCloudflareApi } from "../../src/cloud/api";
import { probeCloud, runCloudSetup, type CloudSetupOutcome } from "../../src/cloud/bringup";
import { WORKER_BUNDLE } from "../../src/cloud/worker-bundle.generated";
import {
  FAKE_ACCOUNT_ID,
  FAKE_API_TOKEN,
  FAKE_BASE,
  FAKE_SUBDOMAIN,
  FakeCloudflare,
  OTHER_MAC,
  THIS_MAC,
  workerFetchFor,
} from "./fake-cloudflare";

let cloud: FakeCloudflare;
let committed: Array<{ workerUrl: string; token: string }>;
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

function setup(over: { thisMachineId?: string; healthFailures?: number } = {}) {
  return {
    api: createCloudflareApi({
      apiToken: FAKE_API_TOKEN,
      fetchImpl: cloud.fetch,
      baseUrl: FAKE_BASE,
    }),
    thisMachineId: over.thisMachineId ?? THIS_MAC,
    mintToken: mintCounter(),
    fetchImpl: workerFetchFor(cloud, {
      ...(over.healthFailures === undefined ? {} : { healthFailures: over.healthFailures }),
    }),
    // The TLS wait is real time in production and no time here.
    sleep: async () => undefined,
    commit: async (c: { workerUrl: string; token: string }) => {
      committed.push(c);
    },
  };
}

async function run(
  over: Parameters<typeof setup>[0] = {},
  req: { slot?: "personal" | "work"; rotateOtherToken?: boolean; subdomain?: string } = {},
): Promise<CloudSetupOutcome> {
  return await runCloudSetup(setup(over), {
    accountId: FAKE_ACCOUNT_ID,
    slot: req.slot ?? "personal",
    ...(req.rotateOtherToken === undefined ? {} : { rotateOtherToken: req.rotateOtherToken }),
    ...(req.subdomain === undefined ? {} : { subdomain: req.subdomain }),
  });
}

beforeEach(() => {
  cloud = new FakeCloudflare();
  committed = [];
  minted = [];
  mintCount = 0;
});

describe("a first run, on a blank account", () => {
  it("creates everything and turns sync on here", async () => {
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
    expect(committed).toEqual([{ workerUrl: out.workerUrl, token: minted[0] }]);
  });

  it("uploads the embedded Worker, pinned to wrangler.toml's compatibility date", async () => {
    await run();
    const upload = cloud.uploads.at(-1);
    expect(upload?.script).toBe(WORKER_BUNDLE);
    expect(upload?.mainModule).toBe("index.js");
    expect(upload?.compatibilityDate).toBe("2026-08-01");
    // Without this the API pins the Worker to the 2021-11-02 runtime, and
    // without `strict` an unresolvable inherit is dropped in silence.
    expect(upload?.strict).toBe(true);
  });

  it("mints BOTH tokens and shows only the other Mac's", async () => {
    const out = await run();
    expect(minted).toHaveLength(2);
    // This Mac's went to the keychain. The other Mac's is returned to be shown
    // once, because there is nowhere else it can ever be read from.
    expect(committed[0]?.token).toBe(minted[0]);
    expect(out.otherMachineToken).toBe(minted[1]);
    expect(out.otherSlot).toBe("work");
    expect(cloud.bindingValue("TOKEN_WORK")).toBe(minted[1]);
  });

  it("stores this Mac's id as PLAIN TEXT, so the next run can read it back", async () => {
    await run();
    const machineId = cloud.script?.bindings.find((b) => b.name === "MACHINE_ID_PERSONAL");
    // The whole of slot detection rests on this. A secret_text machine id
    // cannot be read back, and then neither Mac can tell which one it is.
    expect(machineId?.type).toBe("plain_text");
    expect(machineId?.text).toBe(THIS_MAC);
    // The token, by contrast, must be a secret.
    expect(
      cloud.script?.bindings.find((b) => b.name === "TOKEN_PERSONAL")?.type,
    ).toBe("secret_text");
  });
});

describe("adopting what is already there", () => {
  it("adopts an existing wwb database rather than creating a second one", async () => {
    const existing = cloud.seedDatabase("wwb");
    const out = await run();

    expect(out.ok).toBe(true);
    expect(cloud.databases).toHaveLength(1);
    expect(cloud.databases[0]?.uuid).toBe(existing.uuid);
    expect(cloud.calls.filter((c) => c.method === "POST" && c.path.endsWith("/d1/database"))).toEqual(
      [],
    );
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

describe("the other Mac's token", () => {
  it("survives a re-run untouched, and is not shown again", async () => {
    const first = await run();
    const workToken = first.otherMachineToken;
    expect(workToken).not.toBeNull();

    const second = await run();

    // THE PROPERTY THIS WHOLE FEATURE TURNS ON. Cloudflare will not read a
    // secret back, so an upload that forgot TOKEN_WORK would delete it — and
    // the work Mac would stop syncing with a green tick on this screen.
    expect(cloud.bindingValue("TOKEN_WORK")).toBe(workToken);
    expect(second.otherMachineToken).toBeNull();
    expect(second.steps.find((s) => s.id === "deploy")?.detail).toContain("left alone");

    // It survived as an `inherit`, which is the only mechanism available for a
    // value the uploader cannot see.
    const upload = cloud.uploads.at(-1);
    expect(upload?.bindings.some((b) => b.name === "TOKEN_WORK")).toBe(true);
  });

  it("replaces the other Mac's token ONLY when explicitly asked to", async () => {
    const first = await run();
    const before = cloud.bindingValue("TOKEN_WORK");

    const rotated = await run({}, { rotateOtherToken: true });

    expect(cloud.bindingValue("TOKEN_WORK")).not.toBe(before);
    expect(rotated.otherMachineToken).toBe(cloud.bindingValue("TOKEN_WORK"));
    expect(rotated.otherMachineToken).not.toBe(first.otherMachineToken);
  });

  it("always replaces THIS Mac's token, because the old one cannot be recovered", async () => {
    await run();
    const firstToken = committed[0]?.token;
    await run();
    expect(committed[1]?.token).not.toBe(firstToken);
    expect(cloud.bindingValue("TOKEN_PERSONAL")).toBe(committed[1]?.token);
  });
});

describe("the second Mac", () => {
  /** Mac one has been through the wizard; this is mac two running it. */
  async function afterFirstMac(): Promise<void> {
    await runCloudSetup(
      { ...setup({ thisMachineId: OTHER_MAC }) },
      { accountId: FAKE_ACCOUNT_ID, slot: "personal" },
    );
    committed = [];
    minted = [];
  }

  it("detects that it is the work Mac, without being asked", async () => {
    await afterFirstMac();

    const probe = await probeCloud(
      {
        api: createCloudflareApi({
          apiToken: FAKE_API_TOKEN,
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
        thisMachineId: THIS_MAC,
      },
      FAKE_ACCOUNT_ID,
    );

    const verdict = probe.deployment?.verdict;
    expect(verdict?.kind).toBe("certain");
    expect(verdict?.kind === "certain" ? verdict.slot : null).toBe("work");
  });

  it("sets only its own slot and leaves the first Mac's alone", async () => {
    await afterFirstMac();
    const personalTokenBefore = cloud.bindingValue("TOKEN_PERSONAL");

    const out = await run({ thisMachineId: THIS_MAC }, { slot: "work" });

    expect(out.ok).toBe(true);
    // Its own slot: a fresh token and its own machine id.
    expect(cloud.bindingValue("TOKEN_WORK")).toBe(committed[0]?.token);
    expect(cloud.bindingValue("MACHINE_ID_WORK")).toBe(THIS_MAC);
    // The other slot: byte for byte what it was.
    expect(cloud.bindingValue("TOKEN_PERSONAL")).toBe(personalTokenBefore);
    expect(cloud.bindingValue("MACHINE_ID_PERSONAL")).toBe(OTHER_MAC);
    // And nothing was shown to be carried anywhere — mac one is already set up.
    expect(out.otherMachineToken).toBeNull();
  });

  it("recognises itself on a THIRD run and stays in the same slot", async () => {
    await afterFirstMac();
    await run({ thisMachineId: THIS_MAC }, { slot: "work" });

    const probe = await probeCloud(
      {
        api: createCloudflareApi({
          apiToken: FAKE_API_TOKEN,
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
        thisMachineId: THIS_MAC,
      },
      FAKE_ACCOUNT_ID,
    );
    const verdict = probe.deployment?.verdict;
    expect(verdict?.kind).toBe("certain");
    expect(verdict?.kind === "certain" ? verdict.slot : null).toBe("work");
  });
});

describe("a deployment the shell script made", () => {
  /**
   * `scripts/bringup-cloud.sh` sets the machine ids as SECRETS, so their values
   * cannot be read back — which is exactly the owner's live account today:
   * TOKEN_PERSONAL, TOKEN_WORK and MACHINE_ID_PERSONAL set, MACHINE_ID_WORK not.
   */
  function seedShellScriptDeployment(): void {
    cloud.seedDatabase("wwb");
    cloud.seedScript([
      { type: "d1", name: "DB", database_id: "db-uuid-0000-0000-0000-000000000001" },
      { type: "secret_text", name: "TOKEN_PERSONAL", text: "shell-personal" },
      { type: "secret_text", name: "TOKEN_WORK", text: "shell-work" },
      { type: "secret_text", name: "MACHINE_ID_PERSONAL", text: THIS_MAC },
    ]);
  }

  async function probeAs(machineId: string) {
    return await probeCloud(
      {
        api: createCloudflareApi({
          apiToken: FAKE_API_TOKEN,
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
        thisMachineId: machineId,
      },
      FAKE_ACCOUNT_ID,
    );
  }

  it("still knows the personal Mac, from rows the cloud has already stamped", async () => {
    seedShellScriptDeployment();
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");
    db.schemaApplied = true;
    db.intervalRows = [THIS_MAC];

    const verdict = (await probeAs(THIS_MAC)).deployment?.verdict;

    // Sound rather than lucky: MACHINE_ID_WORK is unset, so the work slot can
    // only ever have stamped the literal word "work". A UUID in the database
    // therefore came from the personal slot.
    expect(verdict?.kind).toBe("certain");
    expect(verdict?.kind === "certain" ? verdict.slot : null).toBe("personal");
  });

  it("asks rather than guesses when this Mac has never synced", async () => {
    seedShellScriptDeployment();
    const db = cloud.databases[0];
    if (db === undefined) throw new Error("no database");
    db.schemaApplied = true;
    db.intervalRows = [OTHER_MAC];

    const verdict = (await probeAs(THIS_MAC)).deployment?.verdict;

    expect(verdict?.kind).toBe("ask");
    expect(verdict?.kind === "ask" ? verdict.suggested : null).toBe("work");
  });

  it("converts the adopted slot's machine id to plain text and preserves the rest", async () => {
    seedShellScriptDeployment();

    const out = await run({ thisMachineId: THIS_MAC }, { slot: "personal" });

    expect(out.ok).toBe(true);
    // Now readable — which is what makes every future run on either Mac exact.
    const mid = cloud.script?.bindings.find((b) => b.name === "MACHINE_ID_PERSONAL");
    expect(mid?.type).toBe("plain_text");
    expect(mid?.text).toBe(THIS_MAC);
    // And the work Mac's token, which nobody can read, is still there.
    expect(cloud.bindingValue("TOKEN_WORK")).toBe("shell-work");
  });
});

describe("failures", () => {
  it("names the missing permission on a 403, not the status code", async () => {
    cloud.denied.add("D1: Edit");
    const out = await run();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("D1: Edit");
    expect(out.error).toContain("permission");
    // And it says where to fix it.
    expect(out.error).toContain("dashboard");
  });

  it("names Workers Scripts: Edit when the deploy is the thing refused", async () => {
    cloud.denied.add("Workers Scripts: Edit");
    const out = await run();

    expect(out.error).toContain("Workers Scripts: Edit");
    expect(out.steps.find((s) => s.id === "deploy")?.state).toBe("failed");
    // The database was created before the refusal, and stays.
    expect(cloud.databases.map((d) => d.name)).toEqual(["wwb"]);
  });

  it("never shows a token the upload did not land", async () => {
    // `scripts/bringup-cloud.sh` learned this first: a token printed by a run
    // that did not upload it is WORSE than no token. It looks exactly like the
    // real thing, and pasting it into the other Mac produces 401s that read as
    // a broken Worker.
    cloud.denied.add("Workers Scripts: Edit");
    const out = await run();

    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.id === "deploy")?.state).toBe("failed");
    expect(out.otherMachineToken).toBeNull();
  });

  it("DOES show it when the upload landed and a later step failed", async () => {
    // The opposite case, and it matters just as much: the token is in
    // Cloudflare, cannot be read back, and a re-run would replace it rather
    // than recover it. Losing it here would strand the other Mac.
    cloud.failOnce.set("/workers/scripts/wwb-sync/subdomain", 500);
    const out = await run();

    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.id === "deploy")?.state).toBe("done");
    expect(out.otherMachineToken).not.toBeNull();
    expect(out.otherMachineToken).toBe(cloud.bindingValue("TOKEN_WORK"));
  });

  it("tells a dead network apart from a refused one", async () => {
    cloud.offline = true;
    const out = await run();

    expect(out.error).toContain("could not reach api.cloudflare.com");
    expect(out.error).not.toContain("permission");
  });

  it("tells a wrong token apart from a token missing a permission", async () => {
    const out = await runCloudSetup(
      {
        ...setup(),
        api: createCloudflareApi({
          apiToken: "the-wrong-token",
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
      },
      { accountId: FAKE_ACCOUNT_ID, slot: "personal" },
    );

    expect(out.error).toContain("did not accept that API token");
    expect(out.error).not.toContain("permission");
  });

  it("refuses a token Cloudflare says is not active", async () => {
    cloud.tokenStatus = "expired";
    const out = await run();
    expect(out.error).toContain("expired");
    expect(out.steps.find((s) => s.id === "token")?.state).toBe("failed");
    expect(cloud.databases).toEqual([]);
  });

  it("waits out the certificate a new workers.dev address has not been issued yet", async () => {
    // DNS resolves before TLS is ready — measured at about two minutes on the
    // first real setup. Reporting that as a failure would send someone
    // debugging a Worker that is perfectly fine.
    const out = await run({ healthFailures: 3 });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.id === "verify")?.state).toBe("done");
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
      { accountId: FAKE_ACCOUNT_ID, slot: "personal" },
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
  const STEPS = ["account", "database", "schema", "deploy", "url", "verify"] as const;
  const FAIL_AT: Record<(typeof STEPS)[number], string> = {
    account: "/d1/database",
    database: "/d1/database",
    schema: "/query",
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
    });
  }
});

describe("choosing an account", () => {
  it("never picks one when the token can reach several", async () => {
    cloud.accounts = [
      { id: FAKE_ACCOUNT_ID, name: "Personal" },
      { id: "00000000000000000000000000000002", name: "Work" },
    ];
    const probe = await probeCloud(
      {
        api: createCloudflareApi({
          apiToken: FAKE_API_TOKEN,
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
        thisMachineId: THIS_MAC,
      },
    );
    // Two accounts and no choice made yet: nothing has been inspected, because
    // creating a database on the wrong one is a bill and a split history.
    expect(probe.accounts).toHaveLength(2);
    expect(probe.deployment).toBeNull();
  });

  it("carries on when the token may not list accounts at all", async () => {
    // Cloudflare documents GET /accounts for API keys, not tokens. A token that
    // cannot enumerate is normal, and the pane asks for the id instead.
    cloud.denied.add("Account Settings: Read");
    const probe = await probeCloud(
      {
        api: createCloudflareApi({
          apiToken: FAKE_API_TOKEN,
          fetchImpl: cloud.fetch,
          baseUrl: FAKE_BASE,
        }),
        thisMachineId: THIS_MAC,
      },
      FAKE_ACCOUNT_ID,
    );
    expect(probe.tokenValid).toBe(true);
    expect(probe.accounts).toEqual([]);
    expect(probe.error).toBeNull();
    expect(probe.deployment?.accountId).toBe(FAKE_ACCOUNT_ID);
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
      { accountId: FAKE_ACCOUNT_ID, slot: "personal" },
    );

    expect(seen.length).toBeGreaterThan(8);
    // Every emission carries all eight steps, so a dropped update costs a
    // stale frame rather than a row stuck on "running" for the session.
    for (const snapshot of seen) expect(snapshot).toHaveLength(8);
    expect(seen.at(-1)?.every((s) => s.state === "done")).toBe(true);
  });
});
