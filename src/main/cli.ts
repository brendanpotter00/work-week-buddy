/**
 * `--selftest`, `--doctor` and the LaunchAgent flags — `docs/IMPL_UI.md` §1.9.
 *
 * Utility modes must NOT take the single-instance lock: `scripts/install.sh`
 * runs `--selftest` against the installed bundle while the app is already
 * running, and a mode that grabbed the lock would either exit immediately or
 * kick the live instance off the database.
 *
 * Pure, and therefore fully tested. `readCliMode` is the only place argv is
 * interpreted.
 */
export type CliMode =
  | { kind: "normal"; hidden: boolean }
  | { kind: "selftest" }
  | { kind: "doctor" }
  | { kind: "smoke" }
  | { kind: "install-launch-agent" }
  | { kind: "uninstall-launch-agent" };

export function readCliMode(argv: readonly string[]): CliMode {
  const has = (f: string): boolean => argv.includes(f);
  // Order is the precedence. --selftest first because it is the install gate.
  if (has("--selftest")) return { kind: "selftest" };
  if (has("--doctor")) return { kind: "doctor" };
  // The launched-app smoke run (`npm run smoke`). A utility mode like the two
  // above: it opens windows and a database of its own and must never take the
  // running instance's lock or its profile.
  if (has("--smoke")) return { kind: "smoke" };
  if (has("--install-launch-agent")) return { kind: "install-launch-agent" };
  if (has("--uninstall-launch-agent")) return { kind: "uninstall-launch-agent" };
  // Anything unrecognised is a normal launch. Electron and macOS both append
  // their own flags (`--no-sandbox`, `-psn_0_…`), so an unknown flag must never
  // be an error.
  return { kind: "normal", hidden: has("--hidden") };
}

/** True for the modes that must not take the single-instance lock. */
export function isUtilityMode(mode: CliMode): boolean {
  return mode.kind !== "normal";
}
