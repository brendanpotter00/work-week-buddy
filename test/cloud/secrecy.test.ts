/**
 * The Cloudflare API token must leave no trace.
 *
 * It is a bigger credential than anything else this app touches: the Worker
 * token can only append rows to one table, while this one can create and delete
 * resources on a live, billable Cloudflare account. The design decision is that
 * it is BORROWED — used for one wizard run and dropped — and this file is the
 * proof, run against the real main-process wiring rather than a description of
 * it.
 *
 * `src/main/token.test.ts` makes the same negative assertions about the Worker
 * token. These are the ones for the API token, plus the one thing that must be
 * true in the other direction: the Worker token really does get stored, and the
 * URL really does reach `settings.json`, or setup did not finish.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSyncConfigGateway } from "../../src/main/bootstrap";
import { createCloudSetupGateway, mintMachineToken } from "../../src/main/cloud-setup";
import { log, logToDirectory, resetLogSinkForTests } from "../../src/main/log";
import { SettingsStore } from "../../src/main/settings";
import { createTokenStore, type SecretVault } from "../../src/main/token";
import {
  FAKE_ACCOUNT_ID,
  FAKE_API_TOKEN,
  FAKE_BASE,
  FAKE_ZONE_ID,
  FAKE_ZONE_NAME,
  FakeCloudflare,
  THIS_MAC,
  sha256Hex,
  workerFetchFor,
} from "./fake-cloudflare";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-cloud-secrecy-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetLogSinkForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Reversible only through this object, exactly like the Keychain-backed one. */
function fakeVault(): SecretVault {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) =>
      Buffer.from(`v1:${Buffer.from(plain, "utf8").toString("base64")}`),
    decryptString: (enc) => {
      const text = enc.toString("utf8");
      if (!text.startsWith("v1:")) throw new Error("not our blob");
      return Buffer.from(text.slice(3), "base64").toString("utf8");
    },
  };
}

/** Every byte of every file under a directory, so nothing can hide in a corner. */
function allBytes(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? allBytes(path) : readFileSync(path).toString("utf8");
    })
    .join("\n");
}

/**
 * A whole main-process sync stack over a throwaway profile.
 *
 * The real `SettingsStore`, the real `createTokenStore`, the real
 * `createSyncConfigGateway` and the real file-backed logger — because the claim
 * being tested is about what ends up on disk, and a stubbed store would prove
 * nothing about that.
 */
async function wire(cloud: FakeCloudflare) {
  const dir = tmp();
  logToDirectory(dir);
  const settings = new SettingsStore(() => dir);
  await settings.load();
  const tokens = createTokenStore(() => dir, fakeVault());
  const reconfigured: unknown[] = [];
  const syncConfig = createSyncConfigGateway({
    settings,
    tokens,
    sync: {
      reconfigure: async (config) => {
        reconfigured.push(config);
      },
    },
  });
  const gateway = createCloudSetupGateway({
    machineId: THIS_MAC,
    syncConfig,
    fetchImpl: async (input, init) => {
      const url = String(input);
      // One `fetch` for two servers: api.cloudflare.com and the Worker itself.
      return url.startsWith(FAKE_BASE)
        ? await cloud.fetch(input, init)
        : await workerFetchFor(cloud)(input, init);
    },
    apiBaseUrl: FAKE_BASE,
    sleep: async () => undefined,
  });
  return { dir, settings, tokens, syncConfig, gateway, reconfigured };
}

describe("the Cloudflare API token is borrowed, never kept", () => {
  it("reaches no file under userData after a full, successful run", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway } = await wire(cloud);

    const result = await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    expect(result.ok, result.error ?? "").toBe(true);

    const onDisk = allBytes(dir);
    expect(onDisk).not.toContain(FAKE_API_TOKEN);
    // Not in any encoding either — `safeStorage` would base64 it if it were
    // ever handed over by mistake.
    expect(onDisk).not.toContain(Buffer.from(FAKE_API_TOKEN, "utf8").toString("base64"));
  });

  it("reaches no file when the run FAILS, which is when logging is loudest", async () => {
    const cloud = new FakeCloudflare();
    cloud.denied.add("Workers Scripts: Edit");
    const { dir, gateway } = await wire(cloud);

    const result = await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    expect(result.ok).toBe(false);
    expect(allBytes(dir)).not.toContain(FAKE_API_TOKEN);
  });

  it("is not in settings.json, which is plaintext on disk", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway, settings } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });

    const json = readFileSync(join(dir, "settings.json"), "utf8");
    expect(json).not.toContain(FAKE_API_TOKEN);
    // No new key of any kind was invented to hold it.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const value of Object.values(parsed)) {
      expect(JSON.stringify(value)).not.toContain(FAKE_API_TOKEN);
    }
    // And the URL, which is NOT a credential, did land.
    expect(settings.get("syncWorkerUrl")).toMatch(/^https:\/\/wwb-sync\./);
  });

  it("is not in wwb.log, even though the run is logged step by step", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    log.info("a line after the run, so the sink is definitely live");

    const logText = readFileSync(join(dir, "wwb.log"), "utf8");
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).not.toContain(FAKE_API_TOKEN);
    // The URL is worth having in the log; it is not a secret.
    expect(logText).toContain("cloud setup succeeded");
  });

  it("is not in anything that crosses IPC back to the renderer", async () => {
    const cloud = new FakeCloudflare();
    const { gateway } = await wire(cloud);

    const probe = await gateway.probe({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    const result = await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });

    expect(JSON.stringify(probe)).not.toContain(FAKE_API_TOKEN);
    expect(JSON.stringify(result)).not.toContain(FAKE_API_TOKEN);
    // Nor in any step's detail line, which is what a screenshot would capture.
    for (const step of result.steps) {
      expect(step.detail ?? "").not.toContain(FAKE_API_TOKEN);
    }
  });

  it("is not in the sync config the doctor and the settings pane read", async () => {
    const cloud = new FakeCloudflare();
    const { gateway, syncConfig } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });

    const state = syncConfig.read();
    // `SyncConfigState` is what feeds both the pane and the doctor's `sync`
    // section, and it has `tokenPresent: boolean` rather than any token.
    expect(JSON.stringify(state)).not.toContain(FAKE_API_TOKEN);
    expect(state.configured).toBe(true);
    expect(state.tokenPresent).toBe(true);
  });
});

describe("the Worker token, by contrast, is stored properly", () => {
  it("goes through safeStorage and not into settings.json", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway, tokens } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });

    const stored = tokens.read();
    expect(stored).not.toBeNull();
    // Cloudflare holds this token's DIGEST, and only its digest. That is what
    // makes a dump of the D1 database hand over nothing presentable.
    expect(cloud.liveTokens().map((t) => t.tokenSha256)).toEqual([sha256Hex(stored ?? "")]);

    // Encrypted at rest: the plaintext is nowhere in the bytes.
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain(stored);
    expect(readFileSync(join(dir, "wwb.log"), "utf8")).not.toContain(stored);
  });

  it("never reaches Cloudflare in plaintext — only its SHA-256 does", async () => {
    const cloud = new FakeCloudflare();
    const { gateway, tokens } = await wire(cloud);
    await gateway.run({ apiToken: FAKE_API_TOKEN, accountId: FAKE_ACCOUNT_ID });

    const stored = tokens.read() ?? "";
    expect(stored).not.toBe("");
    // Every body this run sent anywhere: the enrolment, the revoke, the upload,
    // the schema apply. None of them may carry the token itself.
    const sent = cloud.allRequestBodies();
    expect(sent).not.toContain(stored);
    // Nor in any encoding a careless serialiser might have reached for.
    expect(sent).not.toContain(Buffer.from(stored, "utf8").toString("base64"));
    // But the digest IS there — otherwise nothing was enrolled at all.
    expect(sent).toContain(sha256Hex(stored));
  });

  it("is the token the deployed Worker actually accepts", async () => {
    // The end-to-end version: main hashes with node:crypto, the Worker looks up
    // with WebCrypto. If those disagreed, every machine would 401 for ever.
    const cloud = new FakeCloudflare();
    const { gateway, tokens } = await wire(cloud);
    const result = await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    expect(result.ok, result.error ?? "").toBe(true);

    const res = await workerFetchFor(cloud)("https://wwb-sync.test/machines", {
      headers: { authorization: `Bearer ${tokens.read() ?? ""}` },
    });
    expect(res.status).toBe(200);
  });

  it("makes sync live with no relaunch", async () => {
    const cloud = new FakeCloudflare();
    const { gateway, reconfigured } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
    });
    // `syncConfig.write` reconfigures the live flusher. Without this the app
    // would say "not configured" for the rest of the session after configuring.
    expect(reconfigured).toHaveLength(1);
    expect(reconfigured[0]).toMatchObject({ token: expect.any(String) });
  });

  it("mints 32 random bytes, base64 — the same shape as the shell script", () => {
    const a = mintMachineToken();
    const b = mintMachineToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    // `openssl rand -base64 32` produces exactly this.
    expect(a).toHaveLength(44);
  });
});

/**
 * The custom-domain path, held to the same rule.
 *
 * It makes three more Cloudflare calls than the plain run and writes one more
 * setting, so "the token is borrowed and never kept" has to be proved on THIS
 * path too rather than inferred from the other one.
 */
describe("a run with a custom domain keeps the same promise", () => {
  const CUSTOM = { label: "wwb", zone: { id: FAKE_ZONE_ID, name: FAKE_ZONE_NAME } };

  it("puts the API token in no file, on the path with the extra calls", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway } = await wire(cloud);
    const out = await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
      customDomain: CUSTOM,
    });
    expect(out.ok).toBe(true);
    expect(allBytes(dir)).not.toContain(FAKE_API_TOKEN);
  });

  it("stores the second address as a URL, and it is not a credential", async () => {
    const cloud = new FakeCloudflare();
    const { dir, gateway, settings } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
      customDomain: CUSTOM,
    });

    // Both addresses landed, and the custom one is the one in use.
    expect(settings.get("syncWorkerUrl")).toBe(`https://wwb.${FAKE_ZONE_NAME}`);
    expect(settings.get("syncWorkerUrlAlt")).toMatch(/^https:\/\/wwb-sync\./);
    const json = readFileSync(join(dir, "settings.json"), "utf8");
    expect(json).not.toContain(FAKE_API_TOKEN);
    // A URL, and only a URL. Nothing token-shaped went into the new key.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(String(parsed["syncWorkerUrlAlt"])).toMatch(/^https:\/\//);
  });

  it("clears a stale second address rather than inheriting it", async () => {
    // A run that turns on only one address must not leave the previous run's
    // other address behind: it would be offered in Settings as a live fallback
    // and would answer nothing.
    const cloud = new FakeCloudflare();
    const { gateway, settings } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
      customDomain: CUSTOM,
    });
    expect(settings.get("syncWorkerUrlAlt")).not.toBe("");

    await gateway.run({ apiToken: FAKE_API_TOKEN, accountId: FAKE_ACCOUNT_ID });
    expect(settings.get("syncWorkerUrl")).toMatch(/^https:\/\/wwb-sync\./);
    expect(settings.get("syncWorkerUrlAlt")).toBe("");
  });
});
