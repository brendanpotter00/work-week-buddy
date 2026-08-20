/**
 * The database token — the one secret this app holds, and the only place it is
 * ever at rest.
 *
 * AGENTS.md, "Secrets": the repo is public, so the token goes through Electron
 * `safeStorage.encryptString`, which on macOS is backed by the Keychain. Never
 * a plist, never a dotfile, never `settings.json`, never the asar, never a test
 * fixture, never a commit. CI fails the build if a credential-shaped string
 * appears in a tracked file.
 *
 * ── WHY THE VAULT IS INJECTED ───────────────────────────────────────────────
 * `import { safeStorage } from "electron"` outside a real Electron process
 * resolves to a module whose default export is a path string, so the named
 * import is `undefined` and the failure lands several frames from its cause.
 * Taking the vault as a parameter keeps this file testable in plain Node with a
 * fake, keeps `electron` out of it entirely, and makes "no vault" — a Linux CI
 * box, a Keychain that will not unlock — an ordinary value rather than a crash.
 *
 * A missing, unreadable or foreign-Keychain blob reads as **not configured**.
 * It is not an error worth taking the app down for: the app measures hours
 * perfectly well with no cloud at all, and the doctor reports the state.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";

/** Under `userData`, beside `settings.json` — which never contains the token. */
export const TOKEN_FILE = "sync-token.bin";

/** The slice of Electron's `safeStorage` this module uses. */
export interface SecretVault {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenStore {
  /** False when there is no OS keychain to encrypt with. Then nothing is stored. */
  available(): boolean;
  /** The decrypted token, or null when absent, empty or undecryptable. */
  read(): string | null;
  /** Encrypt and store. An empty string clears it. Throws if there is no vault. */
  write(plain: string): void;
  clear(): void;
  path(): string;
}

/**
 * `dir` arrives LAZILY, as a thunk, for the same reason `SettingsStore` takes
 * one: `app.getPath("userData")` is derived from `app.setName()`, and a field
 * initialiser would read it before `index.ts` has set the name.
 */
export function createTokenStore(dir: () => string, vault: SecretVault | null): TokenStore {
  const path = (): string => join(dir(), TOKEN_FILE);

  const available = (): boolean => {
    if (vault === null) return false;
    try {
      return vault.isEncryptionAvailable();
    } catch (err) {
      // A Keychain that refuses to answer is "no vault", not a crash on boot.
      log.warn("safeStorage.isEncryptionAvailable threw", err);
      return false;
    }
  };

  const clear = (): void => {
    rmSync(path(), { force: true });
  };

  return {
    available,
    path,

    read(): string | null {
      if (vault === null || !available()) return null;
      let blob: Buffer;
      try {
        blob = readFileSync(path());
      } catch {
        // Absent is the normal first-run state, not a failure.
        return null;
      }
      try {
        const token = vault.decryptString(blob).trim();
        return token === "" ? null : token;
      } catch (err) {
        // Restored from another Mac's backup, or the Keychain item was deleted.
        // Unreadable reads as unconfigured; the owner pastes it again.
        log.warn("the stored sync token could not be decrypted — treating it as absent", err);
        return null;
      }
    },

    write(plain: string): void {
      const token = plain.trim();
      if (token === "") {
        clear();
        return;
      }
      if (vault === null || !available()) {
        // Loud, and on a path a human explicitly asked for. The alternative is
        // writing the token somewhere weaker, which is the one thing this
        // module exists to make impossible.
        throw new Error(
          "cannot store the sync token: this system has no available safeStorage backend",
        );
      }
      const p = path();
      mkdirSync(dir(), { recursive: true });
      writeFileSync(p, vault.encryptString(token), { mode: 0o600 });
      // `mode` on writeFileSync only applies when the file is created, so an
      // existing file keeps whatever it had. Say it again, unconditionally.
      chmodSync(p, 0o600);
    },

    clear,
  };
}
