/**
 * `scripts/*.sh` — task 7.1.
 *
 * These scripts sign, install, and gate the app, so a syntax error in one is
 * discovered halfway through replacing /Applications. Every one of them is
 * parsed here, and the two that can change the machine are exercised in their
 * `--dry-run` mode, which routes every mutating command through a printer.
 *
 * NOTHING in this file installs, signs, copies, or loads anything. The
 * assertions at the end of the install-order test prove that.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = join(REPO, "scripts");
const isMac = process.platform === "darwin";

const shellScripts = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".sh"))
  .sort();

/** Runs a script and returns its exit code and combined output. */
function sh(args: readonly string[], env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  const r = spawnSync("bash", [...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      // The scripts check `node -v` against .nvmrc; make sure the pinned Node
      // running this test is the one they find.
      PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("every shell script parses", () => {
  it("finds the scripts at all — a rename must not silently skip this gate", () => {
    expect(shellScripts).toEqual([
      "bringup-cloud.sh",
      "install.sh",
      "launch-agent.sh",
      "make-signing-cert.sh",
    ]);
  });

  it.each(shellScripts)("bash -n %s", (name) => {
    // `bash -n` is the floor. shellcheck is not installed on this host and is
    // not in CI, so a test that assumed it would simply never run.
    expect(() => execFileSync("bash", ["-n", join(SCRIPTS, name)], { encoding: "utf8" })).not.toThrow();
  });

  it.each(shellScripts)("%s is executable, and fails loudly", (name) => {
    const path = join(SCRIPTS, name);
    const src = readFileSync(path, "utf8");
    expect(src.startsWith("#!/usr/bin/env bash")).toBe(true);
    // Without `set -euo pipefail` an install continues past a failed codesign
    // and reports success.
    expect(src).toContain("set -euo pipefail");
    expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
  });
});

describe("make-signing-cert.sh", () => {
  const src = readFileSync(join(SCRIPTS, "make-signing-cert.sh"), "utf8");

  it("passes -legacy to openssl pkcs12 only when openssl is OpenSSL 3", () => {
    // OpenSSL 3's default PKCS#12 algorithms cannot be read by
    // Security.framework, so it needs -legacy. macOS's own /usr/bin/openssl is
    // LibreSSL, which already emits legacy algorithms and REJECTS the flag
    // ("unknown option '-legacy'") — so an unconditional -legacy breaks the
    // script on any Mac without Homebrew's openssl ahead of it on PATH.
    expect(src).toMatch(/LEGACY="-legacy"/);
    expect(src).toMatch(/"OpenSSL 3\."\*\|"OpenSSL 4\."\*/);
    expect(src).toMatch(/"\$OPENSSL" pkcs12 -export \$LEGACY/);
  });

  it("never exports the archive with an empty passphrase", () => {
    // `security import -P ""` fails with "MAC verification failed during PKCS12
    // import (wrong password?)" for an empty-password .p12 — with and without
    // -legacy, and with any -macalg. It reads as a wrong password and is really
    // an empty one, and it made step 2 of this script unreachable.
    expect(src).toMatch(/-passout "pass:\$\{P12_PASS\}"/);
    expect(src).toMatch(/\[ -n "\$P12_PASS" \] \|\| die/);
  });

  it("asks for a code-signing certificate, not a generic one", () => {
    expect(src).toContain("extendedKeyUsage = critical,codeSigning");
  });

  it("tells the reader that both Macs must import the SAME .p12", () => {
    // Two locally generated certificates have different public keys, hence
    // different designated requirements, hence no shared TCC grants.
    expect(src).toMatch(/SAME FILE on the/);
    expect(src).toMatch(/designated requirement/i);
  });

  it("re-imports an existing wwb.p12 rather than minting a second leaf", () => {
    expect(src).toMatch(/if \[ -f "\$DIR\/wwb\.p12" \]/);
  });

  it("does nothing when the identity is already in the keychain", () => {
    // Safe to run twice: the early exit is the idempotency.
    expect(src).toMatch(/identity_present; then\n\s+ok "Already present/);
  });

  it("creates nothing in --dry-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwb-cert-"));
    const target = join(dir, "signing");
    // A keychain path that does not exist stands in for "no certificate yet",
    // which is the state this dry run is describing. It USED to be safe to omit
    // this and let the script look at the real login keychain, because the
    // presence check was `find-identity -v` and -v hides an untrusted
    // self-signed leaf — so a developer who had actually run this script still
    // got the "no identity" path here. The check no longer lies, so the test
    // has to say which keychain it means.
    const { code, out } = sh([
      join(SCRIPTS, "make-signing-cert.sh"),
      "--dir", target,
      "--keychain", join(dir, "no-such.keychain"),
      "--dry-run",
    ]);
    expect(code).toBe(0);
    // -legacy is present or absent depending on which openssl this host has;
    // asserting it unconditionally would fail on a Mac with only LibreSSL.
    expect(out).toMatch(/openssl pkcs12 -export (-legacy )?-inkey/);
    expect(out).toContain("security import");
    expect(existsSync(target)).toBe(false);
  });
});

describe("neither script gates on `find-identity -v`", () => {
  // THE regression test for the whole "Always Trust" saga. `-v` means "the
  // certificate chain validates", which a self-signed leaf's never does unless
  // a human opens Keychain Access and marks it Always Trust. codesign does not
  // care — it signs with an untrusted leaf, and the requirement it produces
  // (`certificate leaf = H"…"`, no anchor clause) is never chain-validated
  // either, by codesign or by TCC. So gating on -v added a GUI step, a login
  // password, and a second-Mac repeat, all to satisfy a check that was asking
  // the wrong question. If `security find-identity -v` comes back, so does all
  // of that.
  it.each(["install.sh", "make-signing-cert.sh"])("%s", (name) => {
    const src = readFileSync(join(SCRIPTS, name), "utf8");
    // Comments stripped: both scripts explain -v at length, and the explanation
    // is the point. What must not come back is the CALL.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/security find-identity -v/);
    // …and the honest check is still there: resolve, then actually sign.
    expect(code).toMatch(/security find-identity -p codesigning/);
    expect(code).toContain("codesign");
  });

  it("resolves the hash identically in both, and refuses to guess between duplicates", () => {
    // The two scripts carry their own copies on purpose: install.sh must not be
    // taken down by a broken or missing make-signing-cert.sh. Copies drift, and
    // this one must not, because the bug it guards is silent — two certificates
    // CAN share the common name (someone re-mints on the second Mac instead of
    // importing wwb.p12), and picking whichever `security` lists first signs
    // with a coin flip and drops every grant on one of the machines.
    const awks = ["install.sh", "make-signing-cert.sh"].map((name) => {
      const src = readFileSync(join(SCRIPTS, name), "utf8");
      return /awk -v want="\$[A-Z_]+" '([\s\S]*?)'\n/.exec(src)?.[1]?.replace(/\s+/g, " ").trim();
    });
    expect(awks[0], "install.sh has no identity awk").toBeTruthy();
    expect(awks[1]).toBe(awks[0]);

    // `break`, never `exit`: exit stops at the first match and hides the second.
    for (const a of awks) {
      expect(a).toContain("break");
      expect(a).not.toContain("exit");
    }
    // And each script must actually count them rather than trusting the first.
    for (const name of ["install.sh", "make-signing-cert.sh"]) {
      expect(readFileSync(join(SCRIPTS, name), "utf8")).toContain("identity_count()");
    }
  });
});

describe("install.sh", () => {
  const src = readFileSync(join(SCRIPTS, "install.sh"), "utf8");

  it("signs by SHA-1, not by common name", () => {
    // Two certificates can share a CN — which is exactly what happens when
    // someone re-mints instead of importing the shared wwb.p12 — and the wrong
    // one produces a different designated requirement and silently drops every
    // grant. The hash is unambiguous. `man codesign`: "If identity consists of
    // exactly forty hexadecimal digits, it is instead interpreted as the SHA-1
    // hash of the certificate part of the desired identity."
    expect(src).toMatch(/--sign "\$\{IDENTITY_HASH:-\$IDENTITY\}"/);
  });

  it("installs to exactly /Applications/Work Week Buddy.app", () => {
    // The TCC grant binds to the on-disk path. Any other destination is an
    // app with no permissions that reports zero hours and looks fine.
    expect(src).toContain('APP_DEST="/Applications/Work Week Buddy.app"');
  });

  it.runIf(!isMac)("refuses to run anywhere but macOS", () => {
    const { code, out } = sh([join(SCRIPTS, "install.sh"), "--dry-run"]);
    expect(code).toBe(1);
    expect(out).toContain("macOS only");
  });

  it.runIf(isMac)("runs its steps in the one order that is safe", () => {
    const before = {
      app: existsSync("/Applications/Work Week Buddy.app"),
      plist: existsSync(join(homedir(), "Library/LaunchAgents/com.bpotter.workweekbuddy.plist")),
    };

    const { code, out } = sh([join(SCRIPTS, "install.sh"), "--dry-run"]);
    expect(code).toBe(0);

    const at = (needle: string): number => {
      const i = out.indexOf(needle);
      expect(i, `missing from the dry run: ${needle}`).toBeGreaterThan(-1);
      return i;
    };

    const npmCi = at("+ npm ci");
    const pkg = at("+ npm run package");
    const sign = at("+ codesign --force --deep");
    const stopAgent = at("+ bash scripts/launch-agent.sh stop");
    const wipe = at("+ rm -rf /Applications/Work Week Buddy.app");
    const copy = at("+ ditto ");
    const selftest = at("--selftest");
    const doctor = at("+ npm run doctor");
    const agent = at("+ bash scripts/launch-agent.sh install");

    expect(npmCi).toBeLessThan(pkg);
    expect(pkg).toBeLessThan(sign);
    // The agent is booted out BEFORE the bundle is replaced: KeepAlive would
    // otherwise relaunch the app from a half-copied /Applications bundle.
    expect(sign).toBeLessThan(stopAgent);
    expect(stopAgent).toBeLessThan(wipe);
    expect(wipe).toBeLessThan(copy);
    // The hard gate runs on the INSTALLED binary, and before launch-at-login is
    // wired up, so a failed self-test can never be left running at every login.
    expect(copy).toBeLessThan(selftest);
    expect(out).toContain('+ "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy" --selftest');
    expect(selftest).toBeLessThan(doctor);
    expect(doctor).toBeLessThan(agent);

    // …and the dry run really was dry.
    expect(existsSync("/Applications/Work Week Buddy.app")).toBe(before.app);
    expect(existsSync(join(homedir(), "Library/LaunchAgents/com.bpotter.workweekbuddy.plist"))).toBe(
      before.plist,
    );
  });

  it.runIf(isMac)("can skip launch-at-login without skipping the install", () => {
    const { code, out } = sh([join(SCRIPTS, "install.sh"), "--dry-run", "--skip-launch-agent"]);
    expect(code).toBe(0);
    expect(out).toContain("+ ditto ");
    expect(out).not.toContain("+ bash scripts/launch-agent.sh install");
  });

  it("gates on the self-test rather than merely running it", () => {
    // `elif "$APP_BIN" --selftest; then … else … exit 1` — the exit is the gate.
    expect(src).toMatch(/SELF-TEST FAILED[\s\S]{0,600}exit 1/);
  });

  it("treats doctor as advisory, and says why", () => {
    // A first install has no permissions yet, so doctor is red by construction
    // at that point. Gating on it would skip launch-at-login on exactly the run
    // that needs it.
    expect(src).toMatch(/Deliberately NOT a gate/);
    expect(src).toMatch(/does not block the install/);
  });

  it("replaces the bundle instead of merging over it", () => {
    expect(src).toMatch(/run rm -rf "\$APP_DEST"/);
    expect(src).toMatch(/run ditto "\$APP_SRC" "\$APP_DEST"/);
  });

  it("refuses to build against the wrong Node", () => {
    expect(src).toContain('WANT="$(tr -d \'[:space:]\' < .nvmrc)"');
    expect(src).toMatch(/if \[ "\$HAVE" != "v\$\{WANT\}" \]/);
  });
});

describe("the LaunchAgent plist", () => {
  function render(env: NodeJS.ProcessEnv = {}): string {
    const r = sh([join(SCRIPTS, "launch-agent.sh"), "render"], env);
    expect(r.code).toBe(0);
    return r.out;
  }

  it("is well-formed, with the keys launch-at-login actually needs", () => {
    const xml = render();
    expect(xml).toContain("<!DOCTYPE plist PUBLIC");
    expect(xml).toContain("<key>Label</key><string>com.bpotter.workweekbuddy</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    // Restart after a crash, but NOT after a clean quit, or the tray's Quit
    // item relaunches the app it just closed.
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
    // A LaunchDaemon has no WindowServer connection and CGEventSource* calls
    // hang there — NON_GOALS #6.
    expect(xml).toContain("<key>LimitLoadToSessionType</key><string>Aqua</string>");
    expect(xml).toContain(
      "<string>/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy</string>",
    );
    expect(xml).toContain("<string>--hidden</string>");
  });

  it("writes absolute log paths — launchd does not expand ~", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "wwb-home-"));
    const xml = render({ HOME: fakeHome });
    expect(xml).toContain(`<string>${fakeHome}/Library/Logs/WorkWeekBuddy/agent.out.log</string>`);
    expect(xml).not.toContain("~/Library");
  });

  it.runIf(isMac)("passes plutil -lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwb-plist-"));
    const path = join(dir, "com.bpotter.workweekbuddy.plist");
    execFileSync("bash", ["-c", `bash ${JSON.stringify(join(SCRIPTS, "launch-agent.sh"))} render > ${JSON.stringify(path)}`]);
    const out = execFileSync("plutil", ["-lint", path], { encoding: "utf8" });
    expect(out).toContain("OK");

    // Parsed by the real plist parser, not by our regexes.
    const args: unknown = JSON.parse(
      execFileSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path], {
        encoding: "utf8",
      }),
    );
    expect(args).toEqual([
      "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy",
      "--hidden",
    ]);
  });

  it("boots the old job out before bootstrapping the new one", () => {
    // `launchctl bootstrap` fails outright on an already-loaded label, so
    // without the bootout this script is not safe to run twice.
    const src = readFileSync(join(SCRIPTS, "launch-agent.sh"), "utf8");
    const bootout = src.indexOf('run launchctl bootout "${DOMAIN}/${LABEL}"');
    const bootstrap = src.indexOf('run launchctl bootstrap "$DOMAIN" "$PLIST"');
    expect(bootout).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(bootout);
  });

  it("loads nothing in --dry-run, and refuses without the installed app", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwb-home-"));
    const forced = sh([join(SCRIPTS, "launch-agent.sh"), "install", "--dry-run", "--force"], {
      HOME: dir,
    });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("+ launchctl bootstrap");
    expect(existsSync(join(dir, "Library/LaunchAgents"))).toBe(false);

    if (!existsSync("/Applications/Work Week Buddy.app")) {
      const guarded = sh([join(SCRIPTS, "launch-agent.sh"), "install", "--dry-run"], { HOME: dir });
      expect(guarded.code).toBe(1);
      expect(guarded.out).toContain("no app at /Applications/Work Week Buddy.app");
    }
  });

  it("reports a missing app as a failure, not as a red cross and exit 0", () => {
    if (existsSync("/Applications/Work Week Buddy.app")) return;
    const r = sh([join(SCRIPTS, "launch-agent.sh"), "status"], {
      HOME: mkdtempSync(join(tmpdir(), "wwb-home-")),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("app missing");
  });

  it("rejects an unknown subcommand instead of guessing", () => {
    expect(sh([join(SCRIPTS, "launch-agent.sh"), "reboot"]).code).toBe(2);
    expect(sh([join(SCRIPTS, "launch-agent.sh")]).code).toBe(2);
  });
});
