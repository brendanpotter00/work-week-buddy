/**
 * Does this Mac actually start Work Week Buddy at login, and does it start THIS
 * copy of it? — `docs/IMPL_UI.md` §1.7.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `doctor()` used to answer with a literal:
 *
 *     autostart: { installed: false, loaded: false, plistPath: "", execMatchesRunningApp: false }
 *
 * On the machine this was written on, launchd had the agent loaded and
 * `state = running` at the time the report said "not installed". A field that
 * cannot be right is worse than a missing one: it reads as a diagnosis.
 *
 * ── ONE AUTOSTART MECHANISM, EVER ───────────────────────────────────────────
 * The LaunchAgent plist is the only one. Do NOT also call
 * `app.setLoginItemSettings()` — two launch paths race the single-instance lock
 * and make this very report lie about which one won.
 *
 * ── execMatchesRunningApp IS THE FIELD THAT EARNS ITS KEEP ──────────────────
 * `installed` and `loaded` only say a plist exists and launchd took it. Neither
 * notices that the plist points at a bundle that was moved, renamed or deleted:
 * launchd keeps the job registered, `launchctl print` keeps succeeding, and the
 * app simply never comes back after a reboot. So the plist's ProgramArguments
 * are read back and compared against the executable actually running, and the
 * target is stat'd — `execExists: false` is a stale plist, and
 * `execMatchesRunningApp: false` with `execExists: true` is usually the far
 * more ordinary "you are running the dev build, whose grants are a different
 * app's". Two causes, two fields, no guessing.
 *
 * ── EVERYTHING HERE IS ASYNC AND NONE OF IT MAY PROMPT ──────────────────────
 * `launchctl print` is a subprocess and `~/Library/LaunchAgents` is a plain
 * unprotected directory, so neither can raise a TCC or Keychain dialog. Both
 * are nonetheless kept off the boot path and behind `execFile` (never
 * `execFileSync`): this app has frozen twice on a synchronous call that put a
 * window on screen in front of a menu-bar app that cannot come to the front,
 * and "it is only a subprocess" is exactly what was said about the last one.
 */
import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AutostartState } from "../shared/ipc-types";

const run = promisify(execFile);

export type { AutostartState };

/** Frozen, and shared with `scripts/launch-agent.sh`, which writes the plist. */
export const AGENT_LABEL = "com.bpotter.workweekbuddy";

/**
 * launchd does not expand `~`, which is why the plist is generated at install
 * time rather than committed. The path is still derivable, and is the only
 * place either side looks.
 */
export function agentPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

/**
 * What `doctor()` reports when nothing asked. Every field is false-y, and
 * `probed: false` is what says so — the distinction `tap.probed` had to learn
 * the hard way (AGENTS.md silent-failure #16).
 */
export const UNPROBED: AutostartState = {
  probed: false,
  installed: false,
  loaded: false,
  plistPath: "",
  execPath: null,
  execExists: false,
  execMatchesRunningApp: false,
};

/**
 * The seams. Defaults do the real thing; the tests hand it a plist on disk and
 * a stubbed `launchctl` so both the healthy case and the moved-bundle case are
 * provable without a LaunchAgent being installed on whatever ran the suite.
 */
export interface AutostartProbe {
  /** Where to look. Defaults to `agentPlistPath()`. */
  readonly plistPath?: string;
  /** The executable to compare against. Defaults to `process.execPath`. */
  readonly runningExecPath?: string;
  readonly readPlist?: (path: string) => Promise<string>;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly isLoaded?: (label: string) => Promise<boolean>;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `launchctl print gui/<uid>/<label>` — exit 0 means launchd knows the job.
 *
 * `list` was the obvious alternative and is the wrong one: it succeeds for jobs
 * in other domains and its output format has changed between releases. `print`
 * is scoped to this GUI session, which is the only domain an Aqua agent can run
 * in, and its exit code alone carries the answer.
 */
async function defaultIsLoaded(label: string): Promise<boolean> {
  const uid = process.getuid?.() ?? 501;
  try {
    await run("/bin/launchctl", ["print", `gui/${String(uid)}/${label}`], { timeout: 10_000 });
    return true;
  } catch {
    // Not loaded, no such domain, or launchctl is unavailable. All three mean
    // "nothing will start this app at login", which is what the field says.
    return false;
  }
}

/**
 * ProgramArguments, out of the plist, without a second subprocess.
 *
 * `plutil -extract` is the robust reader and `scripts/launch-agent.sh` already
 * uses it — but it is another process spawn per doctor call, and this plist is
 * written by that same script from a fixed template. So: find the array that
 * follows the `ProgramArguments` key and take its `<string>` values. Anything
 * this cannot parse yields null, which reports as "no exec path" rather than as
 * a wrong one.
 *
 * Binary plists are deliberately not handled. `launch-agent.sh` writes XML and
 * `plutil -lint`s it before the move; a binary plist here is somebody else's
 * file and guessing at it would be the fabrication this whole change is about.
 */
export function programArgumentsFromPlist(xml: string): string[] | null {
  const key = xml.indexOf("<key>ProgramArguments</key>");
  if (key === -1) return null;
  const open = xml.indexOf("<array>", key);
  if (open === -1) return null;
  const close = xml.indexOf("</array>", open);
  if (close === -1) return null;
  const body = xml.slice(open + "<array>".length, close);
  const args = [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1] ?? ""));
  return args.length === 0 ? null : args;
}

/** `launch-agent.sh` escapes on the way in (`xml_escape`); undo exactly that. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Read-only, and never throws. A doctor that dies while diagnosing is not a
 * doctor — every failure below degrades to a field that says "no", which is
 * the honest answer to "will this start at login" when we could not find out.
 */
export async function verifyLaunchAgent(probe: AutostartProbe = {}): Promise<AutostartState> {
  const plistPath = probe.plistPath ?? agentPlistPath();
  const runningExecPath = probe.runningExecPath ?? process.execPath;
  const readPlist = probe.readPlist ?? ((p: string) => readFile(p, "utf8"));
  const exists = probe.exists ?? defaultExists;
  const isLoaded = probe.isLoaded ?? defaultIsLoaded;

  let xml: string | null = null;
  try {
    xml = await readPlist(plistPath);
  } catch {
    xml = null;
  }

  const args = xml === null ? null : programArgumentsFromPlist(xml);
  const execPath = args?.[0] ?? null;
  const loaded = await isLoaded(AGENT_LABEL).catch(() => false);

  return {
    probed: true,
    installed: xml !== null,
    loaded,
    plistPath,
    execPath,
    execExists: execPath === null ? false : await exists(execPath),
    execMatchesRunningApp: execPath !== null && execPath === runningExecPath,
  };
}
