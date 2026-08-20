/**
 * What this Mac is called.
 *
 * ── THE LABEL IS NEVER ON THE INTERVAL ──────────────────────────────────────
 * `work_interval` stores `machine_id` — the `IOPlatformUUID` — and nothing
 * else about the machine. `byMachine()` LEFT JOINs the `machine` table for a
 * display name. That is the whole reason renaming works the way the owner
 * asked for it: one row changes and every interval this Mac has ever recorded,
 * from the first one to the one that closes tonight, immediately reports under
 * the new name. Denormalising the label onto the row would turn a rename into
 * a backfill and would let old rows disagree with new ones. Do not do it.
 *
 * ── WHERE THE NAME LIVES ────────────────────────────────────────────────────
 * `settings.json` is the authority for THIS Mac's name; the `machine` row is a
 * projection of it, written here so `byMachine` has something to join against,
 * and pushed to the cloud by the heartbeat so the other Mac can join against
 * it too. Before this module existed nothing wrote the local row at all —
 * `SELECT * FROM machine` on a real install returned zero rows and every
 * machine rendered as a bare UUID.
 */
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import { upsertMachine } from "../store/sync-state";
import { log } from "./log";
import type { SettingsStore } from "./settings";

/**
 * The cap `wwb:machine:rename` has always applied. It is here so the renderer,
 * the IPC handler and the tests all read it from one place instead of three
 * copies of `60` drifting apart.
 */
export const MAX_MACHINE_LABEL = 60;

/**
 * Trim, cap, and refuse blank.
 *
 * `null` means "there is no name here", which is different from `""`. Storing
 * the empty string would be storing a name the UI then has to special-case
 * everywhere, and `COALESCE(m.label, i.machine_id)` in `byMachine` would happily
 * hand back `""` and render a blank row — a machine with no name at all is at
 * least honest, a machine with an empty name looks like a rendering bug.
 */
export function normalizeMachineLabel(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_MACHINE_LABEL).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * macOS's own device name — what Finder's sidebar, AirDrop and Sharing all
 * show. `scutil` needs no permission and no FFI, exactly like `ioreg` in
 * `machine-id.ts`, and it is the name the owner has already chosen for this
 * Mac once. Defaulting to it means the first thing they see is right.
 *
 * `null` on a non-Mac or if `scutil` fails; the caller falls back.
 */
export function readComputerName(
  run: () => string = () =>
    execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }),
): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return normalizeMachineLabel(run());
  } catch {
    return null;
  }
}

/**
 * The name an install starts with. Never blank, and never a raw UUID.
 *
 * The old fallback was `machineId.slice(0, 8)` in the tray menu — honest, and
 * unreadable. A truncated id is still the fallback of last resort, but it is
 * prefixed so it reads as a name rather than as a leaked internal.
 */
export function defaultMachineLabel(
  machineId: string,
  computerName: string | null = readComputerName(),
): string {
  if (computerName !== null) return computerName;
  const short = machineId.trim().slice(0, 8);
  return short === "" ? "This Mac" : `Mac ${short}`;
}

export interface MachineNamingDeps {
  readonly db: DatabaseSync;
  readonly machineId: string;
  readonly settings: Pick<SettingsStore, "get" | "set">;
  readonly appVersion: string;
  readonly osVersion?: string;
  /**
   * Best-effort push to the cloud, so the other Mac learns the new name without
   * waiting for the next launch. Absent on an unconfigured install, and it must
   * never reject: renaming with no network is an ordinary thing to do.
   */
  readonly pushHeartbeat?: () => Promise<void>;
  readonly now?: () => number;
}

export interface RenameResult {
  /** The stored name — trimmed and capped, so possibly not what was typed. */
  readonly label: string;
  /**
   * The heartbeat, already in flight. Nothing in the app awaits it: the rename
   * is durable the moment `settings.json` and the `machine` row are written,
   * and blocking a button on a socket that may hang for twenty seconds would
   * make an offline rename *feel* like a failure when it is not one. Tests
   * await it; production does not.
   */
  readonly pushed: Promise<void>;
}

export interface MachineNaming {
  /** This Mac's current name. Never blank. */
  label(): string;
  /** Boot: settle on a default if there is no name yet, then write the row. */
  init(): Promise<string>;
  /** Rename. Throws on empty-after-trim rather than storing `""`. */
  rename(raw: string): Promise<RenameResult>;
  /** Re-write the local row — the name, the versions, and a fresh `last_seen`. */
  touch(): void;
}

export function createMachineNaming(deps: MachineNamingDeps): MachineNaming {
  const now = deps.now ?? Date.now;

  const label = (): string =>
    normalizeMachineLabel(deps.settings.get("machineLabel")) ??
    defaultMachineLabel(deps.machineId);

  const touch = (): void => {
    upsertMachine(deps.db, {
      machineId: deps.machineId,
      label: label(),
      appVersion: deps.appVersion,
      ...(deps.osVersion === undefined ? {} : { osVersion: deps.osVersion }),
      // `now()`, deliberately. This is the only writer that can say anything
      // first-hand about this machine being alive, and the conflict rule in
      // `upsertMachine` is `last_seen_ms` — so a rename made offline outranks
      // the older cloud row that a later pull will bring back.
      lastSeenMs: now(),
    });
  };

  return {
    label,
    touch,

    async init() {
      // Persisted, not merely derived. The rename field has to show the name
      // the machine is actually going by, and the heartbeat has to send it — a
      // default that only exists as a fallback expression reaches neither.
      if (normalizeMachineLabel(deps.settings.get("machineLabel")) === null) {
        await deps.settings.set("machineLabel", defaultMachineLabel(deps.machineId));
      }
      touch();
      return label();
    },

    async rename(raw) {
      const next = normalizeMachineLabel(raw);
      if (next === null) {
        // Loud, not silent. A blank name is a mistake in the UI, and answering
        // it by keeping the old name with no complaint teaches nothing.
        throw new Error("a device name cannot be empty");
      }
      await deps.settings.set("machineLabel", next);
      touch();
      const pushed = (deps.pushHeartbeat?.() ?? Promise.resolve()).catch((err: unknown) => {
        // Already best-effort by contract; this only catches a seam that broke
        // its promise. The name is durable locally either way and the next
        // successful sync carries it.
        log.warn("rename heartbeat failed", err);
      });
      return { label: next, pushed };
    },
  };
}
