/**
 * The one secret this app holds.
 *
 * The repo is public and CI fails the build on a credential-shaped string in a
 * tracked file, so the interesting assertions here are all negative: the token
 * is not in `settings.json`, not in any other file under `userData`, and not
 * recoverable from the bytes on disk without the vault. AGENTS.md, "Secrets".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsStore } from "./settings";
import { createTokenStore, TOKEN_FILE, type SecretVault } from "./token";

/** Not the real token, and shaped so a plaintext leak is unmistakable in a dump. */
const TOKEN = "not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-token-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for `safeStorage`. Reversible only through this object, exactly
 * like the Keychain-backed original: the on-disk bytes do not contain the
 * plaintext in any encoding a `grep` would find.
 */
function fakeVault(over: Partial<SecretVault> = {}): SecretVault {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain, "utf8").toString("base64")}`),
    decryptString: (enc) => {
      const text = enc.toString("utf8");
      if (!text.startsWith("v1:")) throw new Error("not our blob");
      return Buffer.from(text.slice(3), "base64").toString("utf8");
    },
    ...over,
  };
}

/** Every byte of every file under a directory, concatenated. */
function allBytes(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name)).toString("utf8"))
    .join("\n");
}

describe("the token at rest", () => {
  it("round-trips through the vault", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, fakeVault());
    expect(store.read()).toBeNull();
    store.write(TOKEN);
    expect(store.read()).toBe(TOKEN);
  });

  it("never appears in settings.json, or in any other file under userData", async () => {
    const dir = tmp();
    const settings = new SettingsStore(() => dir);
    await settings.load();
    // A full settings write, with the URL half of the configuration set: the
    // URL is an ordinary setting and belongs here. The token does not.
    await settings.patch({ syncWorkerUrl: "https://wwb-sync.example.workers.dev" });

    const store = createTokenStore(() => dir, fakeVault());
    store.write(TOKEN);
    await settings.patch({ machineLabel: "Work laptop" });

    const settingsJson = readFileSync(join(dir, "settings.json"), "utf8");
    expect(settingsJson).toContain("wwb-sync.example.workers.dev");
    expect(settingsJson).not.toContain(TOKEN);
    expect(JSON.parse(settingsJson)).not.toHaveProperty("syncToken");

    // And nowhere else either — including the token file itself, which holds
    // ciphertext. This is the assertion CI's secret scan is the mirror of.
    expect(allBytes(dir)).not.toContain(TOKEN);
    expect(readFileSync(join(dir, TOKEN_FILE)).toString("utf8")).not.toContain(TOKEN);
  });

  it("is stored 0600 — readable by this user and nobody else", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, fakeVault());
    store.write(TOKEN);
    // Written twice: `mode` on writeFileSync applies only on create, so the
    // second write is the one that would leave a loose mode behind.
    store.write(`${TOKEN}-rotated`);
    expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600);
  });

  it("reads as absent — not as an error — when there is no file", () => {
    const store = createTokenStore(() => tmp(), fakeVault());
    expect(store.read()).toBeNull();
    expect(store.available()).toBe(true);
  });

  it("reads as absent when the blob cannot be decrypted", () => {
    // Restored from another Mac's backup, or the Keychain item was deleted.
    // Unconfigured is recoverable by pasting the token again; a throw on the
    // boot path is not.
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "garbage from another keychain");
    const store = createTokenStore(() => dir, fakeVault());
    expect(store.read()).toBeNull();
  });

  it("clears on an empty string rather than storing one", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, fakeVault());
    store.write(TOKEN);
    store.write("   ");
    expect(store.read()).toBeNull();
    expect(readdirSync(dir)).not.toContain(TOKEN_FILE);
  });

  it("trims what it is given — a pasted token carries a newline", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, fakeVault());
    store.write(`  ${TOKEN}\n`);
    expect(store.read()).toBe(TOKEN);
  });
});

describe("no vault", () => {
  it("refuses to store the token rather than storing it weakly", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, null);
    expect(store.available()).toBe(false);
    expect(store.read()).toBeNull();
    expect(() => store.write(TOKEN)).toThrow(/safeStorage/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a vault that reports encryption unavailable the same way", () => {
    const dir = tmp();
    const store = createTokenStore(() => dir, fakeVault({ isEncryptionAvailable: () => false }));
    expect(store.available()).toBe(false);
    expect(() => store.write(TOKEN)).toThrow();
    expect(allBytes(dir)).not.toContain(TOKEN);
  });

  it("treats a vault that throws on the availability check as absent, not fatal", () => {
    const store = createTokenStore(
      () => tmp(),
      fakeVault({
        isEncryptionAvailable: () => {
          throw new Error("keychain locked");
        },
      }),
    );
    expect(store.available()).toBe(false);
    expect(store.read()).toBeNull();
  });
});
