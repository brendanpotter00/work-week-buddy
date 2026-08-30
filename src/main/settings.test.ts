/**
 * `settings.json` on a machine that has been running this app for a while.
 *
 * The file is written by whatever version happened to be installed last and
 * read by whatever is installed now, so it always carries keys the current
 * build has never heard of. That is the ordinary case, not an error, and the
 * one thing this file must never do is decline to load: a settings file the
 * app refuses is a settings file that takes the tracker down with it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsStore, SETTINGS_DEFAULTS } from "./settings";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-settings-"));
  dirs.push(dir);
  return dir;
}

function write(dir: string, contents: unknown): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(contents, null, 2), "utf8");
}

function readBack(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a settings file written by an older build", () => {
  it("loads clean when it still carries the retired mic bundle-id lists", async () => {
    // THE MIGRATION. `meetingApps` and `micIgnoreApps` are on the owner's real
    // machine right now, left there by every build before the mic conjunction
    // was removed (PRD §3.5). Loading one must not throw, must not be treated
    // as a corrupt file, and must not lose the settings sitting beside them.
    const dir = tmp();
    write(dir, {
      machineLabel: "Work laptop",
      idleTimeoutMin: 12,
      meetingApps: ["us.zoom.xos", "com.hnc.Discord"],
      micIgnoreApps: ["com.electron.wispr-flow"],
      heatmapThresholdsH: [2, 5, 8],
    });

    const store = new SettingsStore(() => dir);
    const loaded = await store.load();

    // The keys are gone…
    expect(loaded).not.toHaveProperty("meetingApps");
    expect(loaded).not.toHaveProperty("micIgnoreApps");
    // …and everything that was next to them survived untouched.
    expect(loaded.machineLabel).toBe("Work laptop");
    expect(loaded.idleTimeoutMin).toBe(12);
    expect(loaded.heatmapThresholdsH).toEqual([2, 5, 8]);
    // …and the defaults still filled in what the old file never had.
    expect(loaded.syncWorkerUrl).toBe(SETTINGS_DEFAULTS.syncWorkerUrl);
    // The second address defaults to "", which is the state of every install
    // that has one address — most of them.
    expect(loaded.syncWorkerUrlAlt).toBe("");
    expect(loaded.lastSelfTest).toBeNull();
  });

  it("does not write the retired keys back on the next save", async () => {
    // `load()` spreads the parsed file over the defaults, so without an
    // explicit drop these would ride along forever — re-saved on every edit and
    // re-read on every launch, a dead setting nothing can ever remove.
    const dir = tmp();
    write(dir, { meetingApps: ["us.zoom.xos"], micIgnoreApps: ["com.electron.wispr-flow"] });

    const store = new SettingsStore(() => dir);
    await store.load();
    await store.set("idleTimeoutMin", 11);

    const onDisk = readBack(dir);
    expect(onDisk).not.toHaveProperty("meetingApps");
    expect(onDisk).not.toHaveProperty("micIgnoreApps");
    expect(onDisk["idleTimeoutMin"]).toBe(11);
  });

  it("reads a corrupt file as first run rather than failing to start", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), "{ this is not json", "utf8");
    const store = new SettingsStore(() => dir);
    await expect(store.load()).resolves.toEqual(SETTINGS_DEFAULTS);
  });

  it("reads an absent file as first run", async () => {
    const store = new SettingsStore(() => tmp());
    await expect(store.load()).resolves.toEqual(SETTINGS_DEFAULTS);
  });

  it("loads an idle timeout that is outside the current range without throwing", async () => {
    // `load()` does NOT sanitise, and must not start: this file is the only
    // record of a machine's settings, and the app's job on launch is to measure
    // hours, not to audit a JSON file. Two shapes have to survive.
    //
    // 15 is what is literally on the owner's disk today — inside the range, and
    // the ordinary case. 40 is the one this widening makes possible in the
    // other direction: a file written by a FUTURE build with a wider range, or
    // hand-edited, opened by this one. Neither may be a reason the app declines
    // to start; the value is clamped on the next write through
    // `sanitizeUiSettings`, which is where the invariant lives.
    for (const stored of [15, 40, 1, 0]) {
      const dir = tmp();
      write(dir, { idleTimeoutMin: stored });
      const store = new SettingsStore(() => dir);
      await expect(store.load()).resolves.toMatchObject({ idleTimeoutMin: stored });
    }
  });
});
