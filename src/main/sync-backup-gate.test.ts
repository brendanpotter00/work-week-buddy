/**
 * THE BUG, AS A TEST — the packaged app with no windows.
 *
 * `runCycle("launch")` runs the weekly export, and every filesystem call in
 * that export is synchronous: `readdirSync` in `latestBackup()`,
 * `mkdirSync`/`renameSync` in `weeklyBackup()`, and sqlite's `VACUUM INTO`,
 * which writes straight into the backup directory. That directory is iCloud
 * Drive or `~/Documents`, and macOS answers the first touch of either by
 * BLOCKING the syscall until the consent dialog is answered. On the Electron
 * main thread that is not a slow launch, it is a dead event loop: the tray
 * stops, `second-instance` never fires, no window can be created and no line
 * can be logged.
 *
 * A test cannot make a real `open(2)` block. It does not need to: the rule the
 * fix installs is that NOTHING SYNCHRONOUS TOUCHES THAT DIRECTORY until the
 * async probe has come back. Hold the probe pending and every synchronous call
 * is a violation — which is exactly what the shipped code did on the very first
 * one.
 *
 * This runs on Linux in CI, and it would have failed on the build that shipped.
 */
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestDb } from "../../test/fakes/seed-db";
import { createSyncService } from "./sync";

/** The prompt on screen that nobody has answered. */
const UNANSWERED = new Promise<never>(() => undefined);

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-gate-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the backup pass and the consent prompt", () => {
  it("touches the backup directory with NOTHING synchronous while macOS is still asking", async () => {
    const dir = tmp();
    const service = createSyncService({
      db: openTestDb(),
      config: null,
      machineId: "personal",
      appVersion: "0.1.0-test",
      tz: "UTC",
      backupDir: dir,
      // Pending forever: the dialog is up and the owner has not seen it yet.
      accessProbe: () => UNANSWERED,
      now: () => Date.parse("2026-08-19T12:00:00Z"),
    });
    onTestFinished(async () => {
      await service.stop();
    });

    // A launch does not wait for the cycle, and neither does this. What it does
    // wait for is a HEARTBEAT: the event loop has to still be turning. Before
    // the fix, `runCycle` reached `readdirSync` on its first tick and this
    // promise would never have resolved at all.
    let alive = 0;
    const beat = setInterval(() => {
      alive += 1;
    }, 5);
    void service.runCycle("launch");
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(beat);

    expect(alive).toBeGreaterThan(5);
    // And the directory is untouched: no export, no marker, nothing written
    // into a place macOS has not agreed to yet.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("runs the export as normal once macOS says yes", async () => {
    const dir = tmp();
    const service = createSyncService({
      db: openTestDb(),
      config: null,
      machineId: "personal",
      appVersion: "0.1.0-test",
      tz: "UTC",
      backupDir: dir,
      accessProbe: async () => [],
      now: () => Date.parse("2026-08-19T12:00:00Z"),
    });
    onTestFinished(async () => {
      await service.stop();
    });

    await service.runCycle("launch");
    const { readdirSync } = await import("node:fs");
    // The week's pair, exactly as before the gate existed.
    expect(readdirSync(dir).sort()).toEqual([
      "wwb-2026-W34.ndjson.gz",
      "wwb-2026-W34.sqlite",
    ]);
  });

  it("still exports when macOS says NO — the sync calls fail fast, they do not hang", async () => {
    const dir = tmp();
    const denied = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const service = createSyncService({
      db: openTestDb(),
      config: null,
      machineId: "personal",
      appVersion: "0.1.0-test",
      tz: "UTC",
      backupDir: dir,
      accessProbe: () => Promise.reject(denied),
      now: () => Date.parse("2026-08-19T12:00:00Z"),
    });
    onTestFinished(async () => {
      await service.stop();
    });

    // "Denied" is a decision, and a decided directory cannot block. The pass
    // runs and either succeeds (as here, where the temp dir is writable) or
    // fails fast with EPERM, which the backup layer already models.
    await expect(service.runCycle("launch")).resolves.toBeUndefined();
  });

  it("says out loud that it skipped the export, rather than skipping it in silence", async () => {
    const dir = tmp();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    onTestFinished(() => spy.mockRestore());

    const service = createSyncService({
      db: openTestDb(),
      config: null,
      machineId: "personal",
      appVersion: "0.1.0-test",
      tz: "UTC",
      backupDir: dir,
      backupAccess: async () => "undecided",
      now: () => Date.parse("2026-08-19T12:00:00Z"),
    });
    onTestFinished(async () => {
      await service.stop();
    });

    await service.runCycle("launch");
    // A backup that quietly stopped happening is the failure mode this whole
    // layer exists against.
    expect(errors.join("\n")).toMatch(/backup skipped/i);
  });
});
