/**
 * Device naming.
 *
 * The test this file exists for is `renaming relabels the history` — the
 * owner's requirement, in his own words: "if I rename this, every data point
 * that comes from this machine should now be relabeled with that name."
 *
 * It is asserted from BOTH sides, because either one alone would pass while the
 * feature was wrong:
 *
 *   • `byMachine()` reports the old intervals under the new name — the
 *     behaviour that was asked for.
 *   • not one `work_interval` row changed — the reason it works. The label is
 *     joined at query time and is never stored on the interval, so a rename is
 *     one row and the whole history follows. Denormalising the label onto the
 *     rows would make the first assertion pass too, by way of a backfill that
 *     can half-fail and leave a year of history disagreeing with itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_POLICY } from "../store/policy";
import { byMachine } from "../store/queries";
import { readMachines, upsertMachine } from "../store/sync-state";
import { NOW_IN_WEEK, openTestDb, seed, t } from "../../test/fakes/seed-db";
import { fakeSettings } from "../../test/helpers/runtime";
import {
  createMachineNaming,
  defaultMachineLabel,
  normalizeMachineLabel,
  readComputerName,
  MAX_MACHINE_LABEL,
  type MachineNaming,
} from "./device-name";
import { SettingsStore } from "./settings";

const MACHINE = "00000000-0000-0000-0000-00000000AAAA";
const P = DEFAULT_POLICY;

/** Throwaway `userData` directories, for the one test that uses a real one. */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two intervals before the rename and one after, all on this machine. */
function seedHistory(db: DatabaseSync): void {
  seed(db, [
    { id: "old-1", machineId: MACHINE, start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    { id: "old-2", machineId: MACHINE, start: "2026-08-18T13:00:00Z", end: "2026-08-18T14:00:00Z" },
    { id: "new-1", machineId: MACHINE, start: "2026-08-19T09:00:00Z", end: "2026-08-19T10:00:00Z" },
  ]);
}

function allIntervalRows(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT * FROM work_interval ORDER BY id").all();
}

interface Made {
  naming: MachineNaming;
  db: DatabaseSync;
  settings: ReturnType<typeof fakeSettings>;
  beats: string[];
}

function make(over: { machineLabel?: string; pushHeartbeat?: () => Promise<void> } = {}): Made {
  const db = openTestDb();
  const settings = fakeSettings(
    over.machineLabel === undefined ? {} : { machineLabel: over.machineLabel },
  );
  const beats: string[] = [];
  let tick = NOW_IN_WEEK;
  const naming = createMachineNaming({
    db,
    machineId: MACHINE,
    settings: settings as unknown as SettingsStore,
    appVersion: "0.1.0-test",
    osVersion: "26.5.1",
    pushHeartbeat:
      over.pushHeartbeat ??
      (async () => {
        beats.push(settings.get("machineLabel"));
      }),
    // Monotonic, so `last_seen_ms` orders the writes the way wall time would.
    now: () => (tick += 1000),
  });
  return { naming, db, settings, beats };
}

// ── the requirement ─────────────────────────────────────────────────────────

describe("renaming relabels the whole history", () => {
  it("reports intervals recorded BEFORE the rename under the new name", async () => {
    const { naming, db } = make({ machineLabel: "MacBook Pro" });
    seedHistory(db);
    await naming.init();

    expect(byMachine(db, P, "UTC", NOW_IN_WEEK).map((m) => m.label)).toEqual(["MacBook Pro"]);

    await naming.rename("The loft mini");

    // Same two pre-rename intervals, same hours, new name. No backfill ran and
    // none was needed.
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)).toEqual([
      {
        machineId: MACHINE,
        label: "The loft mini",
        hours: 3,
        intervals: 3,
        meetingHours: 0,
        jigglerHours: 0,
      },
    ]);
  });

  it("rewrites NOT ONE work_interval row", async () => {
    const { naming, db } = make({ machineLabel: "MacBook Pro" });
    seedHistory(db);
    await naming.init();
    const before = allIntervalRows(db);

    await naming.rename("The loft mini");
    await naming.rename("Renamed again");

    // Byte-for-byte. `machine_id` is the only machine identity an interval
    // carries, and it must never be touched by a rename: it is the key the
    // cross-machine union merge groups on, and rewriting it would fork this
    // Mac's history in two.
    expect(allIntervalRows(db)).toEqual(before);
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)[0]?.label).toBe("Renamed again");
  });

  it("keeps the other machine's rows out of it", async () => {
    const { naming, db } = make({ machineLabel: "MacBook Pro" });
    seedHistory(db);
    seed(db, [
      { id: "other", machineId: "other-mac", start: "2026-08-18T09:00:00Z", end: "2026-08-18T10:00:00Z" },
    ]);
    upsertMachine(db, { machineId: "other-mac", label: "Work laptop", lastSeenMs: NOW_IN_WEEK });
    await naming.init();

    await naming.rename("The loft mini");

    expect(byMachine(db, P, "UTC", NOW_IN_WEEK).map((m) => [m.machineId, m.label])).toEqual([
      [MACHINE, "The loft mini"],
      ["other-mac", "Work laptop"],
    ]);
  });
});

// ── the row nobody was writing ──────────────────────────────────────────────

describe("the local machine row", () => {
  it("is written at boot, with the versions and a last-seen stamp", async () => {
    const { naming, db } = make({ machineLabel: "MacBook Pro" });

    // The bug this fixes: before `init()` existed, `upsertMachine` had no
    // caller at all and this table stayed empty forever on a real install.
    expect(readMachines(db)).toEqual([]);

    await naming.init();

    expect(readMachines(db)).toEqual([
      {
        machineId: MACHINE,
        label: "MacBook Pro",
        osVersion: "26.5.1",
        appVersion: "0.1.0-test",
        lastSeenMs: expect.any(Number),
      },
    ]);
  });

  it("defaults an unnamed install to the macOS device name and PERSISTS it", async () => {
    const { naming, settings, db } = make();
    expect(settings.get("machineLabel")).toBe("");

    const label = await naming.init();

    // Persisted rather than merely derived: the rename field has to show the
    // name the machine is going by, and the heartbeat has to send it. A default
    // that lives only in a fallback expression reaches neither.
    expect(settings.get("machineLabel")).toBe(label);
    expect(readMachines(db)[0]?.label).toBe(label);
    expect(label).not.toBe("");
    expect(label).not.toBe(MACHINE);
  });

  it("moves last_seen_ms forward on a rename, so a stale cloud row cannot win", async () => {
    const { naming, db } = make({ machineLabel: "MacBook Pro" });
    await naming.init();
    const first = readMachines(db)[0]!.lastSeenMs;

    await naming.rename("The loft mini");

    expect(readMachines(db)[0]!.lastSeenMs).toBeGreaterThan(first);
  });
});

// ── the name never renders blank ────────────────────────────────────────────

describe("an unnamed machine still has a name", () => {
  it("never renders blank and never renders a bare UUID", () => {
    // No ComputerName to read — a non-Mac, or an ioreg/scutil that failed.
    const fallback = defaultMachineLabel(MACHINE, null);
    expect(fallback).not.toBe("");
    expect(fallback).not.toBe(MACHINE);
    // Prefixed, so a truncated id reads as a name rather than a leaked
    // internal. The old tray fallback was the bare eight characters.
    expect(fallback).toBe("Mac 00000000");
  });

  it("prefers the macOS device name when there is one", () => {
    expect(defaultMachineLabel(MACHINE, "The loft mini")).toBe("The loft mini");
  });

  it("has something to say even with no machine id at all", () => {
    expect(defaultMachineLabel("", null)).toBe("This Mac");
  });

  it("reads scutil, and tolerates it failing", () => {
    // `scutil --get ComputerName` prints the name and a newline.
    expect(readComputerName(() => "The loft mini\n")).toBe(
      process.platform === "darwin" ? "The loft mini" : null,
    );
    expect(
      readComputerName(() => {
        throw new Error("no such file");
      }),
    ).toBeNull();
    // A Mac with a blank ComputerName is not a Mac with a name of "".
    expect(readComputerName(() => "   \n")).toBeNull();
  });

  it("falls back for a machine that has no row at all", () => {
    // `byMachine` LEFT JOINs, so a machine we hold intervals for but have never
    // heard a heartbeat from is labelled by its id rather than vanishing. Still
    // ugly, still never blank — and it is the state this whole feature exists
    // to get out of.
    const db = openTestDb();
    seed(db, [
      { id: "x", machineId: "unseen-mac", start: "2026-08-17T09:00:00Z", end: "2026-08-17T10:00:00Z" },
    ]);
    expect(byMachine(db, P, "UTC", NOW_IN_WEEK)[0]?.label).toBe("unseen-mac");
  });
});

// ── validation ──────────────────────────────────────────────────────────────

describe("validation", () => {
  it("trims", () => {
    expect(normalizeMachineLabel("   The loft mini   ")).toBe("The loft mini");
  });

  it("caps at the existing 60 characters", () => {
    const long = "x".repeat(200);
    expect(normalizeMachineLabel(long)).toHaveLength(MAX_MACHINE_LABEL);
    expect(MAX_MACHINE_LABEL).toBe(60);
    // Trimmed AGAIN after the cut: slicing mid-space would otherwise store a
    // name with a trailing blank that nothing later would clean up.
    expect(normalizeMachineLabel(`${"x".repeat(59)}   y`)).toBe("x".repeat(59));
  });

  it("refuses empty-after-trim rather than storing an empty string", async () => {
    const { naming, settings, db } = make({ machineLabel: "MacBook Pro" });
    await naming.init();

    for (const blank of ["", "   ", "\t\n "]) {
      await expect(naming.rename(blank)).rejects.toThrow(/cannot be empty/);
    }

    // The old name survived, and the row was not blanked either. `""` would
    // render as a blank row in the breakdown, which reads as a broken app.
    expect(settings.get("machineLabel")).toBe("MacBook Pro");
    expect(readMachines(db)[0]?.label).toBe("MacBook Pro");
    expect(normalizeMachineLabel("  ")).toBeNull();
  });
});

// ── propagation ─────────────────────────────────────────────────────────────

describe("propagation", () => {
  it("pushes a heartbeat carrying the NEW name", async () => {
    const { naming, beats } = make({ machineLabel: "MacBook Pro" });
    await naming.init();

    const { pushed } = await naming.rename("The loft mini");
    await pushed;

    // The label the heartbeat reads must be the one just stored, not the one
    // this Mac booted with.
    expect(beats).toEqual(["The loft mini"]);
  });

  it("does not fail, or lose the name, when the push does", async () => {
    const { naming, settings, db } = make({
      machineLabel: "MacBook Pro",
      pushHeartbeat: () => Promise.reject(new TypeError("fetch failed")),
    });
    await naming.init();

    // Airplane mode. Renaming offline is an ordinary thing to do, so it
    // resolves — the durable part is `settings.json` and the local row, and
    // both are already written by the time the push is even attempted.
    const res = await naming.rename("The loft mini");
    await expect(res.pushed).resolves.toBeUndefined();

    expect(res.label).toBe("The loft mini");
    expect(settings.get("machineLabel")).toBe("The loft mini");
    expect(readMachines(db)[0]?.label).toBe("The loft mini");
  });

  it("survives a relaunch, through the real settings file", async () => {
    // `fakeSettings` above holds the name in memory. This is the same flow
    // against `SettingsStore`, so the rename is proved DURABLE rather than
    // merely applied: the app that reopens tomorrow reads it back off disk.
    const dir = mkdtempSync(join(tmpdir(), "wwb-naming-"));
    dirs.push(dir);
    const db = openTestDb();

    const settings = new SettingsStore(() => dir);
    await settings.load();
    const naming = createMachineNaming({
      db,
      machineId: MACHINE,
      settings,
      appVersion: "0.1.0-test",
    });
    await naming.init();
    await naming.rename("The loft mini");

    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({
      machineLabel: "The loft mini",
    });

    const reopened = new SettingsStore(() => dir);
    expect((await reopened.load()).machineLabel).toBe("The loft mini");
  });

  it("works with no cloud at all", async () => {
    const db = openTestDb();
    const settings = fakeSettings({ machineLabel: "MacBook Pro" });
    // An unconfigured install: no Worker URL, no token, no `pushHeartbeat`.
    const naming = createMachineNaming({
      db,
      machineId: MACHINE,
      settings: settings as unknown as SettingsStore,
      appVersion: "0.1.0-test",
      now: () => t("2026-08-19T12:00:00Z"),
    });
    await naming.init();

    const res = await naming.rename("The loft mini");
    await res.pushed;

    expect(readMachines(db)[0]).toEqual({
      machineId: MACHINE,
      label: "The loft mini",
      osVersion: null,
      appVersion: "0.1.0-test",
      lastSeenMs: t("2026-08-19T12:00:00Z"),
    });
  });
});
