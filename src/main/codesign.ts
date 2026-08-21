/**
 * The bundle's code identity — the thing every TCC grant is actually bound to.
 *
 * ── WHY A DOCTOR CARES ──────────────────────────────────────────────────────
 * macOS does not grant Input Monitoring to a path. It grants it to (bundle id,
 * designated requirement) and remembers the pair. Re-sign the app with a
 * different identity and the grant that is still ticked in System Settings
 * stops applying to the binary now sitting at that path: the tap comes back
 * with the keyboard bits stripped, hours quietly come out low, and every
 * permission screen says "granted". `AGENTS.md` silent-failure #2.
 *
 * So the doctor records the designated requirement — hashed, because the raw
 * string carries a certificate hash and this repository is public — and whether
 * the signature still verifies. A `designatedRequirementSha256` that CHANGED
 * between two reports is the explanation for a permission that "was working
 * yesterday", and nothing else in the report can produce it.
 *
 * `valid: false` is a broken seal: an app modified after signing. On an ad-hoc
 * rebuild it is also how you find out the copy in `/Applications` is not the
 * copy `install.sh` signed.
 *
 * ── ASYNC, BOUNDED, NEVER FATAL ─────────────────────────────────────────────
 * `/usr/bin/codesign` cannot prompt — it reads the bundle and the system's own
 * trust store — but `--verify` walks every file in an Electron app and takes
 * seconds on a cold cache. It is therefore `execFile`, never `execFileSync`,
 * with a timeout, and it lives nowhere near the boot path. A failure of any
 * kind is `null`, which reads as "not known", not as "not signed".
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { CodesignState } from "../shared/ipc-types";

const run = promisify(execFile);

export type { CodesignState };

/** Long enough for a cold `--verify` on an Electron bundle, short enough to give up. */
const TIMEOUT_MS = 30_000;

/**
 * `designatedRequirementSha256` is a HASH rather than the requirement string
 * because the string contains `certificate leaf = H"…"` and reports get pasted
 * into issues on a public repository. A hash answers the only question anyone
 * asks of it — "is this the same identity as last time?" — and leaks nothing.
 */
export const UNPROBED: CodesignState = {
  probed: false,
  designatedRequirementSha256: null,
  valid: null,
};

export interface CodesignProbe {
  /** The bundle to inspect. Defaults to the running app's bundle. */
  readonly bundlePath?: string;
  readonly designatedRequirement?: (bundlePath: string) => Promise<string | null>;
  readonly verify?: (bundlePath: string) => Promise<boolean | null>;
}

/**
 * `/Applications/Work Week Buddy.app` from
 * `/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy`.
 *
 * Derived from the running executable rather than hardcoded, so a doctor run
 * against a dev build or a bundle on an external volume reports on the bundle
 * it is actually inside instead of on whatever happens to be in /Applications.
 */
export function bundlePathOf(execPath: string): string {
  const marker = "/Contents/MacOS/";
  const at = execPath.lastIndexOf(marker);
  return at === -1 ? execPath : execPath.slice(0, at);
}

/**
 * The `designated =>` line out of `codesign -d -r-` stdout.
 *
 * TWO FORMATS, and only one of them was handled the first time this was
 * written. A bundle signed with a real identity prints
 *
 *     designated => identifier "com.bpotter.workweekbuddy" and certificate leaf = H"6b69…"
 *
 * but an ad-hoc signature — which is what `npm install electron` ships, and
 * what any local rebuild without a certificate produces — has no requirement
 * expressible in requirement language, so codesign emits it COMMENTED OUT:
 *
 *     # designated => cdhash H"7f63…"
 *
 * Both were measured on this machine. Missing the `#` form meant the field
 * reported `null` on exactly the builds whose identity churns most, which is
 * the population it is most useful for.
 */
export function designatedRequirementFrom(stdout: string): string | null {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim().replace(/^#\s*/, "");
    if (!line.startsWith("designated =>")) continue;
    const requirement = line.slice("designated =>".length).trim();
    return requirement === "" ? null : requirement;
  }
  return null;
}

async function defaultDesignatedRequirement(bundlePath: string): Promise<string | null> {
  try {
    // `-r-` prints the requirement to stdout; `-d` puts the rest on stderr,
    // which is why only stdout is read here.
    const { stdout } = await run("/usr/bin/codesign", ["-d", "-r-", "--", bundlePath], {
      timeout: TIMEOUT_MS,
    });
    return designatedRequirementFrom(stdout);
  } catch {
    // Unsigned, no such bundle, or no codesign. "Not known", not "not signed".
    return null;
  }
}

async function defaultVerify(bundlePath: string): Promise<boolean | null> {
  try {
    // NOT `--deep`. Deep verification re-walks every nested framework and
    // helper — minutes on an Electron app — and Apple deprecated it for
    // verification anyway. The top-level seal is what breaks when a bundle is
    // edited in place, which is the failure this field is here to catch.
    await run("/usr/bin/codesign", ["--verify", "--", bundlePath], { timeout: TIMEOUT_MS });
    return true;
  } catch (err) {
    // A non-zero exit is a real answer: the seal did not verify. Anything that
    // never ran at all (ENOENT, timeout) has no status and stays unknown.
    return typeof (err as { code?: unknown }).code === "number" ? false : null;
  }
}

/** Read-only, bounded, and never throws. */
export async function readCodesign(probe: CodesignProbe = {}): Promise<CodesignState> {
  const bundlePath = probe.bundlePath ?? bundlePathOf(process.execPath);
  const requirement = await (probe.designatedRequirement ?? defaultDesignatedRequirement)(
    bundlePath,
  ).catch(() => null);
  const valid = await (probe.verify ?? defaultVerify)(bundlePath).catch(() => null);
  return {
    probed: true,
    designatedRequirementSha256:
      requirement === null ? null : createHash("sha256").update(requirement).digest("hex"),
    valid,
  };
}
