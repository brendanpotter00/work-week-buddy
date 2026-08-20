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

  it("degrades to console when the directory cannot be written, and says so once", () => {
    quiet();
    // An unwritable sink must never become the reason a log line is lost or an
    // app stops: the logger is the last thing standing when everything else is.
    expect(logToDirectory("/proc/definitely/not/writable/wwb")).toBeNull();
    expect(() => log.error("still works")).not.toThrow();
    expect(logFilePath()).toBeNull();
  });
});
