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
  FakeCloudflare,
  THIS_MAC,
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
      slot: "personal",
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
      slot: "personal",
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
      slot: "personal",
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
      slot: "personal",
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
      slot: "personal",
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
      slot: "personal",
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
      slot: "personal",
    });

    const stored = tokens.read();
    expect(stored).not.toBeNull();
    // It is the one Cloudflare is holding, or this Mac cannot sync.
    expect(stored).toBe(cloud.bindingValue("TOKEN_PERSONAL"));

    // Encrypted at rest: the plaintext is nowhere in the bytes.
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain(stored);
    expect(readFileSync(join(dir, "wwb.log"), "utf8")).not.toContain(stored);
  });

  it("makes sync live with no relaunch", async () => {
    const cloud = new FakeCloudflare();
    const { gateway, reconfigured } = await wire(cloud);
    await gateway.run({
      apiToken: FAKE_API_TOKEN,
      accountId: FAKE_ACCOUNT_ID,
      slot: "personal",
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
