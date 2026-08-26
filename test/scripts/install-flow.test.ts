/**
 * `scripts/install.sh` — the whole flow, actually executed.
 *
 * `shell.test.ts` parses these scripts and reads their `--dry-run` transcript.
 * That proves the ORDER is right and proves nothing about whether the commands
 * work, and the two of them had never been run for real: the owner's install is
 * still the ad-hoc bundle that `npm run package` emits, which is exactly the
 * problem the signing certificate exists to prevent.
 *
 * So this file runs it. Real `ditto`, real replace, real self-test gate, real
 * plist through `plutil -lint` — every destination redirected into a fresh
 * `mkdtemp`, which is the only reason it is safe to run on the machine that
 * also holds the real install.
 *
 * ── WHAT THIS FILE MAY NOT TOUCH, EVER ──────────────────────────────────────
 *   /Applications                     the real install lives there
 *   ~/Library/LaunchAgents            the real launch-at-login
 *   ~/Library/Application Support/…   the real database
 *   the login keychain                a certificate is a human decision
 *   launchd                           bootstrapping into this session is real
 * The last assertion of the first test re-checks the first three afterwards,
 * and `--no-sign` / `--no-launchctl` are what keep the last two out of reach.
 *
 * The two steps that genuinely cannot be exercised here, and are therefore
 * verified by hand and written up in docs/BRINGUP.md instead:
 *   * codesign with the real leaf — it needs a trusted certificate in a real
 *     keychain, and trust cannot be granted without a GUI password prompt.
 *   * `--selftest` on the real bundle — it needs Input Monitoring, which is
 *     the grant the whole exercise is about.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL = join(REPO, "scripts", "install.sh");
const CERT = join(REPO, "scripts", "make-signing-cert.sh");
const isMac = process.platform === "darwin";

const REAL_APP = "/Applications/Work Week Buddy.app";
const REAL_PLIST = join(homedir(), "Library/LaunchAgents/com.bpotter.workweekbuddy.plist");
const REAL_SUPPORT = join(homedir(), "Library/Application Support/Work Week Buddy");

let root = "";

/**
 * A .app whose executable answers `--selftest` with whatever we tell it to.
 *
 * `WWB_STUB_SELFTEST_EXIT` is the verdict; `WWB_STUB_SELFTEST_OUT` is a line of
 * the report, on stderr, where the real `--selftest` writes its readable
 * rendering. The two are independent on purpose: a run that could not measure
 * something exits ZERO and still has to be noticed.
 */
function stubBundle(at: string, marker: string): string {
  const app = join(at, "Work Week Buddy.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  const bin = join(app, "Contents", "MacOS", "Work Week Buddy");
  writeFileSync(
    bin,
    '#!/bin/sh\n' +
      'if [ "${1:-}" = "--selftest" ]; then\n' +
      '  [ -n "${WWB_STUB_SELFTEST_OUT:-}" ] && printf "%s\\n" "$WWB_STUB_SELFTEST_OUT" >&2\n' +
      '  exit "${WWB_STUB_SELFTEST_EXIT:-0}"\n' +
      "fi\n" +
      "exit 0\n",
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(app, "Contents", "Resources", "marker.txt"), marker);
  return app;
}

function sh(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } {
  const r = spawnSync("bash", [script, ...args], {
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

/** install.sh, pointed entirely at the scratch tree. */
function install(
  dest: string,
  src: string,
  extra: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } {
  return sh(
    INSTALL,
    [
      "--dest", dest,
      "--app-src", src,
      "--plist-dir", join(root, "LaunchAgents"),
      "--log-dir", join(root, "Logs"),
      // Nothing may reach the keychain, launchd, or /Applications.
      "--no-sign",
      "--no-launchctl",
      "--skip-doctor",
      ...extra,
    ],
    env,
  );
}

/** `plutil -extract KEY raw`, so the plist is parsed by the plist parser. */
function plistValue(path: string, key: string): string {
  const r = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path], {
    encoding: "utf8",
  });
  expect(r.status, `plutil -extract ${key}: ${r.stderr}`).toBe(0);
  return (r.stdout ?? "").trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wwb-install-flow-"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.runIf(isMac)("install.sh, executed end to end into a scratch tree", () => {
  it("builds nothing it was given, installs it, and gates on the self-test", () => {
    // Snapshot the untouchables. Their state is whatever this machine happens
    // to have; the assertion is that this test does not change it.
    const before = {
      app: existsSync(REAL_APP) ? statSync(REAL_APP).mtimeMs : null,
      plist: existsSync(REAL_PLIST),
      support: existsSync(REAL_SUPPORT) ? statSync(REAL_SUPPORT).mtimeMs : null,
    };

    const src = stubBundle(join(root, "src"), "v1");
    const dest = join(root, "Applications", "Work Week Buddy.app");
    const r = install(dest, src);

    expect(r.code, r.out).toBe(0);
    // The destination is not /Applications, so it is not an install and the
    // script has to say so — an override that goes unmentioned is how a test
    // rig turns into someone's broken machine.
    expect(r.out).toContain("NOT A REAL INSTALL");
    expect(r.out).toContain("2. Build and package (skipped");
    expect(r.out).toContain("self-test passed");
    expect(existsSync(join(dest, "Contents/MacOS/Work Week Buddy"))).toBe(true);
    expect(readFileSync(join(dest, "Contents/Resources/marker.txt"), "utf8")).toBe("v1");

    // …and the real machine is exactly as it was.
    expect(existsSync(REAL_APP) ? statSync(REAL_APP).mtimeMs : null).toBe(before.app);
    expect(existsSync(REAL_PLIST)).toBe(before.plist);
    expect(existsSync(REAL_SUPPORT) ? statSync(REAL_SUPPORT).mtimeMs : null).toBe(
      before.support,
    );
  });

  it("is safe to run twice, and leaves nothing of the old build behind", () => {
    const src = stubBundle(join(root, "src2"), "v1");
    const dest = join(root, "twice", "Work Week Buddy.app");

    expect(install(dest, src).code).toBe(0);

    // A file that exists only in the OLD install. `cp -R` would merge and keep
    // it; `rm -rf` + `ditto` is what makes the second run a replacement.
    const stale = join(dest, "Contents/Resources/stale.txt");
    writeFileSync(stale, "from the previous build");

    const second = install(dest, stubBundle(join(root, "src3"), "v2"));
    expect(second.code, second.out).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(dest, "Contents/Resources/marker.txt"), "utf8")).toBe("v2");
  });

  it("aborts on a failed self-test, BEFORE launch-at-login is wired up", () => {
    // The whole point of the gate. An app that cannot tell its own jiggle from
    // human input must never be left running at every login: it would count the
    // jiggler as work and inflate the week with fake time, silently.
    const src = stubBundle(join(root, "src4"), "v1");
    const dest = join(root, "gated", "Work Week Buddy.app");
    rmSync(join(root, "LaunchAgents"), { recursive: true, force: true });

    const r = install(dest, src, [], { WWB_STUB_SELFTEST_EXIT: "1" });

    expect(r.code).toBe(1);
    expect(r.out).toContain("SELF-TEST FAILED");
    // The bundle IS installed by then — the gate is deliberately after the copy
    // so that `--selftest` runs against the installed path, which is the only
    // one whose TCC grants are the real ones.
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(root, "LaunchAgents/com.bpotter.workweekbuddy.plist"))).toBe(false);
  });

  it("shows the report it gated on instead of swallowing it", () => {
    // The gate captures the transcript so it can tell a clean pass from one
    // that could not measure something. Capturing it must not stop the owner
    // seeing it: a gate that prints nothing for eight seconds and then aborts
    // is one nobody trusts.
    const src = stubBundle(join(root, "src-echo"), "v1");
    const dest = join(root, "echo", "Work Week Buddy.app");

    const r = install(dest, src, [], {
      WWB_STUB_SELFTEST_OUT: "  FAIL posted event was kCGEventNull · 5",
      WWB_STUB_SELFTEST_EXIT: "1",
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL posted event was kCGEventNull");
  });

  it("does not blame discrimination for a check that is about the cursor", () => {
    // The old message said the app "could not prove it can tell its own
    // synthetic jiggle from human input" whatever had failed. For the cursor
    // check that is simply untrue — discrimination passed in both of the
    // owner's failing runs — and a gate that misdescribes its own failure sends
    // whoever reads it after the wrong bug.
    const src = stubBundle(join(root, "src-msg"), "v1");
    const dest = join(root, "msg", "Work Week Buddy.app");

    const r = install(dest, src, [], { WWB_STUB_SELFTEST_EXIT: "1" });

    expect(r.code).toBe(1);
    expect(r.out).not.toContain("could not prove it can tell its own synthetic jiggle");
    // It names both promises and points at the line that says which one broke.
    expect(r.out).toContain("DISCRIMINATION");
    expect(r.out).toContain("UNOBTRUSIVENESS");
    expect(r.out).toContain("Read the FAIL line above");
  });

  it("warns but installs when a check COULD NOT BE MEASURED", () => {
    // The whole point of the third state. `--selftest` runs one line after an
    // install the owner just typed, so the Mac is in use by definition; a check
    // that cannot get a verdict under those conditions must not stop the
    // install. A gate that fails during normal use is one its owner learns to
    // bypass — which is exactly what happened, twice, before this existed.
    const src = stubBundle(join(root, "src-inconclusive"), "v1");
    const dest = join(root, "inconclusive", "Work Week Buddy.app");
    const plistDir = join(root, "LaunchAgents");
    rmSync(plistDir, { recursive: true, force: true });

    const r = install(dest, src, [], {
      WWB_STUB_SELFTEST_OUT: "  self-test: 25 checks · 24 ok · 1 COULD NOT BE MEASURED",
      WWB_STUB_SELFTEST_EXIT: "0",
    });

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("COULD NOT BE MEASURED");
    // Not reported as a clean pass…
    expect(r.out).not.toContain("self-test passed");
    // …and not treated as a failure either.
    expect(r.out).not.toContain("SELF-TEST FAILED");
    // The install really did continue: launch-at-login is wired up.
    expect(existsSync(join(plistDir, "com.bpotter.workweekbuddy.plist"))).toBe(true);
  });

  it("still reports a clean run as a clean pass", () => {
    // If every run warned, the warning would stop meaning anything.
    const src = stubBundle(join(root, "src-clean"), "v1");
    const dest = join(root, "clean", "Work Week Buddy.app");

    const r = install(dest, src, [], {
      WWB_STUB_SELFTEST_OUT: "  self-test: 25 checks · 25 ok",
      WWB_STUB_SELFTEST_EXIT: "0",
    });

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("self-test passed");
    expect(r.out).not.toContain("COULD NOT BE MEASURED");
  });

  it("writes a plist launchd will accept, pointing at what it just installed", () => {
    const src = stubBundle(join(root, "src5"), "v1");
    const dest = join(root, "agent", "Work Week Buddy.app");
    const plistDir = join(root, "LaunchAgents");
    rmSync(plistDir, { recursive: true, force: true });

    const r = install(dest, src);
    expect(r.code, r.out).toBe(0);

    const plist = join(plistDir, "com.bpotter.workweekbuddy.plist");
    expect(existsSync(plist)).toBe(true);
    expect(spawnSync("plutil", ["-lint", plist], { encoding: "utf8" }).status).toBe(0);

    const args: unknown = JSON.parse(
      spawnSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist], {
        encoding: "utf8",
      }).stdout,
    );
    expect(args).toEqual([join(dest, "Contents/MacOS/Work Week Buddy"), "--hidden"]);
    // launchd does not expand ~, so an absolute log path is the whole point of
    // generating this file rather than committing one.
    expect(plistValue(plist, "StandardOutPath")).toBe(join(root, "Logs", "agent.out.log"));
    expect(plistValue(plist, "Label")).toBe("com.bpotter.workweekbuddy");

    // …and launchd was never spoken to.
    expect(r.out).toContain("skipped (--no-launchctl): launchctl bootstrap");
    expect(r.out).not.toContain("bootstrapped gui/");
  });

  it("refuses to install without the signing identity", () => {
    // Signing is what gives the bundle a stable designated requirement, and a
    // TCC grant binds to that. Installing without one produces an app that
    // re-prompts on every rebuild, so this is a hard precondition, not a warning.
    // A keychain path that does not exist stands in for "no certificate":
    // `security find-identity` reports zero identities and exits 0 for it.
    const src = stubBundle(join(root, "src6"), "v1");
    const dest = join(root, "unsigned", "Work Week Buddy.app");
    const r = sh(INSTALL, [
      "--dest", dest,
      "--app-src", src,
      "--keychain", join(root, "no-such.keychain"),
      "--plist-dir", join(root, "LaunchAgents"),
      "--log-dir", join(root, "Logs"),
      "--no-launchctl",
      "--skip-doctor",
    ]);

    expect(r.code).toBe(1);
    // Not "no VALID identity". "Valid" was `find-identity -v`, which means "the
    // certificate chain validates" — something a self-signed leaf never does
    // unless someone marks it Always Trust in Keychain Access by hand. The
    // identity was usable the whole time; only this check said otherwise, and
    // it sent people hunting through Keychain Access for a problem that did not
    // exist. The gate is now "resolve it, then actually sign with it".
    expect(r.out).toContain("no 'WWB Local Signing' codesigning identity");
    expect(r.out).not.toContain("Always Trust");
    expect(r.out).toContain("make-signing-cert.sh");
    expect(existsSync(dest)).toBe(false);
  });
});

describe("the launch form install.sh gates on", () => {
  it("never starts Electron with a script path", () => {
    // `electron out/main/index.js` puts app.getAppPath() at out/main/, so
    // preloadPath() looks for out/main/out/preload/index.js. The preload never
    // loads, window.wwb is undefined, and every window renders empty — with no
    // error that names the cause. `electron .` reads package.json's `main` and
    // puts getAppPath() at the project root, which is where the packaged app
    // has it too.
    //
    // `selftest` carried the broken form for a while and got away with it,
    // because a self-test opens no window. install.sh HARD-GATES on --selftest,
    // so "got away with it" was the whole of the safety margin.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, body] of Object.entries(pkg.scripts)) {
      const bad = /\belectron\s+(?!\.(\s|$))[^\s]+/.exec(body);
      expect(bad?.[0], `npm run ${name}: ${body}`).toBeUndefined();
    }
  });
});

describe.runIf(isMac)("make-signing-cert.sh, executed for real into a scratch dir", () => {
  it("mints an importable PKCS#12 without going anywhere near a keychain", () => {
    const dir = join(root, "signing");
    const r = sh(CERT, [
      "--dir", dir,
      "--no-import",
      // Nothing may consult, and certainly not write, the login keychain.
      "--keychain", join(root, "no-such.keychain"),
    ]);

    expect(r.code, r.out).toBe(0);
    for (const f of ["key.pem", "cert.pem", "wwb.p12"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    // 0700 on the directory: this holds a signing key.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("produces an archive that opens with the passphrase the script documents", () => {
    // ── The bug this test exists for ──────────────────────────────────────
    // The script used to export with `-passout pass:` and import with -P "".
    // `security import` rejects an empty-password .p12 with "MAC verification
    // failed during PKCS12 import (wrong password?)" — every time, with and
    // without -legacy, and with any -macalg. It reads as a wrong password and
    // is really an empty one, and it made step 2 of the script unreachable.
    const dir = join(root, "signing");
    const r = spawnSync(
      "bash",
      [
        "-c",
        // Read it back with the SAME openssl resolution the script uses, so a
        // LibreSSL host and an OpenSSL 3 host both exercise their own path.
        `set -e
         O="$(command -v openssl || echo /usr/bin/openssl)"
         case "$("$O" version)" in "OpenSSL 3."*|"OpenSSL 4."*) L=-legacy ;; *) L= ;; esac
         "$O" pkcs12 -in ${JSON.stringify(join(dir, "wwb.p12"))} $L -nokeys -passin pass:work-week-buddy`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("BEGIN CERTIFICATE");
  });

  it("re-imports an existing archive instead of minting a second leaf", () => {
    // Two locally generated certificates have different public keys, hence
    // different designated requirements, hence no shared TCC grants. A second
    // run on the second Mac MUST reuse the file it was given.
    const dir = join(root, "signing");
    const first = readFileSync(join(dir, "cert.pem"));
    const r = sh(CERT, ["--dir", dir, "--no-import", "--keychain", join(root, "nope.keychain")]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("reusing existing");
    expect(readFileSync(join(dir, "cert.pem"))).toEqual(first);
  });

  it("issues a code-signing leaf that outlives the project", () => {
    const dir = join(root, "signing");
    // -text rather than -ext: LibreSSL is what /usr/bin/openssl is, and it
    // does not have -ext.
    const x509 = (args: readonly string[]): string =>
      spawnSync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-noout", ...args], {
        encoding: "utf8",
      }).stdout;
    expect(x509(["-subject"])).toContain("WWB Local Signing");
    expect(x509(["-text"])).toContain("Code Signing");
    // 7300 days ≈ 20 years. An expired leaf means a NEW leaf, which means
    // re-granting Input Monitoring and Accessibility on both Macs.
    const notAfter = x509(["-enddate"]).replace("notAfter=", "").trim();
    const years = (Date.parse(notAfter) - Date.now()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(15);
  });

  it("refuses an empty passphrase rather than minting an unimportable archive", () => {
    const r = sh(CERT, [
      "--dir", join(root, "never"),
      "--no-import",
      "--keychain", join(root, "nope.keychain"),
      "--p12-pass", "",
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("may not be empty");
  });

  it("says one true thing when there is no identity — not two contradictory ones", () => {
    // `--show` used to print "no 'WWB Local Signing' identity" and then, on the
    // very next line, "it IS in the keychain but is not trusted". Both cannot be
    // true, and neither told the reader what to do.
    const r = sh(CERT, ["--show", "--keychain", join(root, "nope.keychain")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no 'WWB Local Signing' identity");
    expect(r.out).not.toContain("is not trusted");
    expect(r.out).not.toContain("Always Trust");
    // …and it says what to do instead.
    expect(r.out).toContain("make-signing-cert.sh");
  });
});

/**
 * The success path of the precondition, against the REAL certificate.
 *
 * Skipped when this Mac has no `WWB Local Signing` identity, which is every CI
 * runner and any fresh clone — there is no way to fake it, because putting a
 * scratch keychain where codesign can see it means mutating the user's global
 * keychain search list, and a test suite may not do that.
 *
 * Where it does run it is the thing that was broken: on a machine whose leaf is
 * untrusted (the normal, expected state), the old gate reported "0 valid
 * identities found" and refused to install.
 */
const hasLocalIdentity =
  isMac &&
  spawnSync("bash", [CERT, "--print-hash"], { encoding: "utf8", cwd: REPO }).status === 0;

describe.runIf(hasLocalIdentity)("the real signing identity on this Mac", () => {
  it("is usable even though `find-identity -v` calls it invalid", () => {
    const all = spawnSync("security", ["find-identity", "-p", "codesigning"], {
      encoding: "utf8",
    }).stdout;
    const valid = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    }).stdout;

    expect(all).toContain("WWB Local Signing");
    // The precondition this repo used to gate on. If this ever starts passing,
    // someone marked the certificate Always Trust — which is harmless, but the
    // point is that it is NOT required for anything below.
    const trusted = valid.includes("WWB Local Signing");

    const r = sh(CERT, ["--show"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("able to sign");
    // Signing works whether or not the chain validates.
    expect(r.out, `trusted=${trusted}`).toMatch(/certificate leaf = H"[0-9a-f]{40}"/);
  });
});
