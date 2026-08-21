/**
 * The log file, because a GUI launch has no stderr.
 *
 * The packaged app that shipped with no windows also shipped with nothing to
 * read: `console.*` reaches a terminal and the owner's app is launched by
 * Finder. Everything below is about the file being there, being appended to
 * before the next thing runs, and never being the reason something else breaks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOG_FILENAME, log, logFilePath, logToDirectory, resetLogSinkForTests } from "./log";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetLogSinkForTests();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every level writes to console too; the tests do not need to see it. */
function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("the log file", () => {
  it("writes every level into <userData>/wwb.log", () => {
    quiet();
    const dir = tmp();
    expect(logToDirectory(dir)).toBe(join(dir, LOG_FILENAME));

    log.info("hello");
    log.warn("careful");
    log.error("broken");

    const text = readFileSync(join(dir, LOG_FILENAME), "utf8");
    expect(text).toMatch(/INFO .*hello/);
    expect(text).toMatch(/WARN .*careful/);
    expect(text).toMatch(/ERROR.*broken/);
  });

  it("keeps the boot breadcrumbs, which are the whole diagnosis when a boot hangs", () => {
    quiet();
    const dir = tmp();
    logToDirectory(dir);
    log.boot("tray up");
    // A frozen boot leaves a log that simply STOPS. The last line names the
    // step that never returned, which is how the freeze was actually found.
    expect(readFileSync(join(dir, LOG_FILENAME), "utf8")).toMatch(/boot: tray up/);
  });

  it("carries a stack, not just a message", () => {
    quiet();
    const dir = tmp();
    logToDirectory(dir);
    log.error("boot failed", new Error("kaboom"));
    const text = readFileSync(join(dir, LOG_FILENAME), "utf8");
    expect(text).toContain("kaboom");
    expect(text).toMatch(/log\.test\.ts/); // the stack came with it
  });

  it("is silent, not fatal, before a directory is set", () => {
    quiet();
    expect(logFilePath()).toBeNull();
    expect(() => log.info("nowhere to go")).not.toThrow();
  });

  it("rotates at a megabyte rather than growing until nobody can open it", () => {
    quiet();
    const dir = tmp();
    const path = join(dir, LOG_FILENAME);
    writeFileSync(path, "x".repeat(1_200_000));
    logToDirectory(dir);
    log.info("after rotation");
    expect(readFileSync(path, "utf8")).toMatch(/after rotation/);
    expect(readFileSync(path, "utf8").length).toBeLessThan(1_000);
    expect(readFileSync(`${path}.1`, "utf8").length).toBe(1_200_000);
  });

  it("writes NOTHING to stdout — stdout belongs to the report", () => {
    // `--doctor` writes a DoctorReport and `--selftest` writes a SelfTestReport,
    // each as one JSON document on stdout, each parsed by a script. Info used
    // to take `console.log`, so every `--doctor` run opened with
    // `[wwb] boot: ready · mode=doctor …` ahead of the `{` and `npm run doctor`
    // answered "could not obtain a report — is the app installed?" out of a
    // perfectly healthy app.
    //
    // Asserted against the console METHODS rather than the streams, because
    // vitest replaces `console` with its own reporter-bound one and nothing
    // reaches `process.stdout.write` from inside a test. That is still the
    // exact claim: in Node `console.log` is stdout and `console.warn` /
    // `console.error` are stderr, and taking `console.log` is the entire bug.
    const toStdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warned: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(" "));
    });
    const wroteToStdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    log.info("an info line");
    log.boot("ready · mode=doctor");
    log.warn("a warning");
    log.error("a failure");

    expect(toStdout).not.toHaveBeenCalled();
    expect(wroteToStdout).not.toHaveBeenCalled();
    expect(errored.join("\n")).toContain("an info line");
    expect(errored.join("\n")).toContain("boot: ready · mode=doctor");
    expect(warned.join("\n")).toContain("a warning");
    expect(errored.join("\n")).toContain("a failure");
  });

  it("degrades to console when the directory cannot be written, and says so once", () => {
    quiet();
    // A REGULAR FILE where a parent directory should be. ENOTDIR, on every
    // platform and whatever the process's uid is — which a permission-based
    // fixture is not (root ignores the mode) and an OS-special path is REALLY
    // not: the first version of this test used `/proc/...`, and
    // `mkdirSync("/proc/x/y", { recursive: true })` does not fail on Linux, it
    // HANGS. It hung this repo's CI for twenty minutes, which is a small
    // rhyme with the bug the rest of this branch is about.
    const dir = tmp();
    const notADirectory = join(dir, "occupied");
    writeFileSync(notADirectory, "I am a file");

    // An unwritable sink must never become the reason a log line is lost or an
    // app stops: the logger is the last thing standing when everything else is.
    expect(logToDirectory(join(notADirectory, "wwb"))).toBeNull();
    expect(() => log.error("still works")).not.toThrow();
    expect(logFilePath()).toBeNull();
  });
});
