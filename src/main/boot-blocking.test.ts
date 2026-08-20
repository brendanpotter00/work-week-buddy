/**
 * THE BOOT PATH MAY NOT CALL ANYTHING THAT CAN PUT UP A DIALOG.
 *
 * Two releases in a row shipped a packaged app that launched, showed nothing,
 * and logged nothing. Both times the main thread was parked inside a
 * synchronous macOS call waiting for a human:
 *
 *   #21  `readdirSync` on iCloud Drive, behind a TCC consent prompt
 *   this  `safeStorage.decryptString()`, behind a Keychain prompt — which an
 *         ad-hoc signed rebuild earns on EVERY launch, because its code
 *         identity changes with every build
 *
 * A blocked main thread is not a slow app. It is a dead event loop: no window
 * is created, the tray never updates, `second-instance` never fires, and not
 * one line reaches the log, because logging is code and code does not run.
 *
 * The rule these tests enforce is the general one, not either example:
 * `createCoreServices()` — everything `index.ts` awaits before the tray and the
 * windows exist — TOUCHES THE VAULT ZERO TIMES. The keychain read happens in
 * `unlockSync()`, which runs after the app is on screen.
 *
 * A vault that counts its calls is the whole fixture. It cannot block, so these
 * run on Linux in CI; what they assert is that the call is not made at all,
 * which is the only version of "cannot block" that is checkable.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeSettings } from "../../test/helpers/runtime";
import { createCoreServices } from "./bootstrap";
import type { SettingsStore } from "./settings";
import { TOKEN_FILE, type SecretVault } from "./token";

/** Every call is a chance to block. Counting them is the test. */
function countingVault(): SecretVault & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable(): boolean {
      calls.push("isEncryptionAvailable");
      return true;
    },
    encryptString(plain: string): Buffer {
      calls.push("encryptString");
      return Buffer.from(plain, "utf8");
    },
    decryptString(blob: Buffer): string {
      calls.push("decryptString");
      return blob.toString("utf8");
    },
  };
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-boot-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(dir: string, over: Record<string, unknown> = {}) {
  const vault = countingVault();
  const settings = fakeSettings({ machineId: "personal", machineLabel: "Personal", ...over });
  const services = await createCoreServices({
    userDataDir: dir,
    settings: settings as unknown as SettingsStore,
    appVersion: "0.1.0-test",
    isPackaged: false,
    tz: "UTC",
    vault,
    backupDir: join(dir, "backups"),
  });
  onTestFinished(async () => {
    await services.sync.stop();
    services.watchdog.stop();
  });
  return { services, vault };
}

describe("createCoreServices — the part of boot that runs before any window", () => {
  it("never touches the vault, even with a token sitting on disk", async () => {
    const dir = tmp();
    // The owner's state exactly: sync turned on, a token stored. This is the
    // shape that froze — `read()` was called here and the Keychain held the
    // main thread until a dialog nobody could see was answered.
    writeFileSync(join(dir, TOKEN_FILE), "an-encrypted-blob");

    const { vault } = await boot(dir, { syncWorkerUrl: "https://sync.example.com" });

    expect(vault.calls).toEqual([]);
  });

  it("starts unconfigured rather than guessing, and says so honestly", async () => {
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "an-encrypted-blob");
    const { services } = await boot(dir, { syncWorkerUrl: "https://sync.example.com" });
    // Unconfigured is a state this layer already models. Boot is allowed to be
    // in it for a moment; it is not allowed to block finding out.
    expect(services.sync.configured).toBe(false);
  });
});

describe("unlockSync — the keychain, after there is a window in front of it", () => {
  it("reads the token and configures the service", async () => {
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "sekrit");
    const { services, vault } = await boot(dir, { syncWorkerUrl: "https://sync.example.com" });

    const result = await services.unlockSync();

    expect(vault.calls).toContain("decryptString");
    expect(result.configured).toBe(true);
    expect(services.sync.configured).toBe(true);
  });

  it("does not touch the keychain at all when sync was never turned on", async () => {
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "sekrit");
    // No worker URL: `resolveSyncConfig` answers "not configured" whatever the
    // token says, so asking the Keychain could only ever cost a prompt. This is
    // how the app ships and how most launches run.
    const { services, vault } = await boot(dir, { syncWorkerUrl: "" });

    const result = await services.unlockSync();

    expect(vault.calls).toEqual([]);
    expect(result.configured).toBe(false);
  });

  it("does not touch the keychain when there is no token file to decrypt", async () => {
    const dir = tmp();
    const { services, vault } = await boot(dir, { syncWorkerUrl: "https://sync.example.com" });

    await services.unlockSync();

    // The file is knowable from a stat. `isEncryptionAvailable()` reaches the
    // Keychain too, so checking it first was a prompt risk taken for nothing.
    expect(vault.calls).toEqual([]);
  });

  it("reports how long the keychain took, because a slow one IS the bug", async () => {
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "sekrit");
    const { services } = await boot(dir, { syncWorkerUrl: "https://sync.example.com" });
    const result = await services.unlockSync();
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("survives a vault that throws instead of answering", async () => {
    const dir = tmp();
    writeFileSync(join(dir, TOKEN_FILE), "sekrit");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => spy.mockRestore());

    const vault: SecretVault = {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(p),
      decryptString: () => {
        throw new Error("the keychain said no");
      },
    };
    const settings = fakeSettings({
      machineId: "personal",
      machineLabel: "Personal",
      syncWorkerUrl: "https://sync.example.com",
    });
    const services = await createCoreServices({
      userDataDir: dir,
      settings: settings as unknown as SettingsStore,
      appVersion: "0.1.0-test",
      isPackaged: false,
      tz: "UTC",
      vault,
      backupDir: join(dir, "backups"),
    });
    onTestFinished(async () => {
      await services.sync.stop();
      services.watchdog.stop();
    });

    // An unreadable token is "not configured", never a boot failure.
    await expect(services.unlockSync()).resolves.toMatchObject({ configured: false });
  });
});
