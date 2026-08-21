/**
 * Fixtures for the main-process tests.
 *
 * Everything here runs against the FAKE `SignalSource` and an in-memory
 * database: no Electron, no Mac, no TCC grant, no waiting. A test that only
 * passed because the terminal running it happened to hold Accessibility would
 * be worse than no test — it would report green on a machine where the app is
 * silently dead.
 */
import type { DatabaseSync } from "node:sqlite";

import { FakeSignalSource } from "../../src/native";
import { DEFAULT_POLICY, openDb, type Policy } from "../../src/store";
import { createRuntime, type AppRuntime, type RuntimeChange } from "../../src/main/runtime";
import type { SyncSeam } from "../../src/main/sync-seam";
import type { AutostartState, CodesignState, SelfTestResult } from "../../src/shared/ipc-types";
import type { MainSettings } from "../../src/main/settings";
import { SETTINGS_DEFAULTS } from "../../src/main/settings";

/** 2023-11-14T22:13:20.000Z — a Tuesday, deliberately mid-week. */
export const T0 = 1_700_000_000_000;
export const MIN = 60_000;

export interface Harness {
  runtime: AppRuntime;
  source: FakeSignalSource;
  db: DatabaseSync;
  policy: Policy;
  changes: RuntimeChange[];
  close(): void;
}

export async function makeHarness(
  over: {
    policy?: Partial<Policy>;
    machineId?: string;
    tz?: string;
    jigglerIntervalMs?: number;
    idleTimeoutMs?: number;
    start?: boolean;
    /**
     * Omitted behaves exactly like an unconfigured install. A function form is
     * offered because the interesting seam — the real sync service — needs the
     * harness's own database, which does not exist until this call.
     */
    sync?: SyncSeam | ((db: DatabaseSync) => SyncSeam) | null;
    /**
     * The doctor's identity reads. Omitted, `doctor()` reports `probed: false`
     * for both — which is what a report from a process that never asked must
     * say, and is the whole reason these are seams rather than literals.
     */
    autostart?: AutostartState;
    codesign?: CodesignState;
    isPackaged?: boolean;
    osVersion?: string;
  } = {},
): Promise<Harness> {
  const policy: Policy = { ...DEFAULT_POLICY, ...over.policy };
  const db = openDb(":memory:", policy);
  const source = new FakeSignalSource();
  let n = 0;
  // In memory, but REAL: production keeps this in `settings.json` so the
  // settings pane can say when the jiggler self-test last passed. Wiring it
  // here means `doctor().selfTest` behaves the same way in a test as it does in
  // the app — null until something runs it, and the stored answer after.
  let selfTest: SelfTestResult | null = null;
  const runtime = createRuntime({
    db,
    source,
    machineId: over.machineId ?? "machine-a",
    appVersion: "0.0.0-test",
    // UTC everywhere, so expected numbers can be computed by hand from the
    // clock times in the test rather than from whatever zone CI runs in.
    tz: over.tz ?? "UTC",
    policy,
    // Deterministic ids: a failing case is reproducible and row order is stable.
    newId: () => `iv-${n++}`,
    jigglerIntervalMs: over.jigglerIntervalMs ?? 30_000,
    selfTestStore: {
      read: () => selfTest,
      write: (r) => {
        selfTest = r;
      },
    },
    ...(over.sync === undefined
      ? {}
      : { sync: typeof over.sync === "function" ? over.sync(db) : over.sync }),
    ...(over.idleTimeoutMs === undefined ? {} : { config: { idleTimeoutMs: over.idleTimeoutMs } }),
    ...(over.isPackaged === undefined ? {} : { isPackaged: over.isPackaged }),
    ...(over.osVersion === undefined ? {} : { osVersion: over.osVersion }),
    ...(over.autostart === undefined
      ? {}
      : { autostart: (): Promise<AutostartState> => Promise.resolve(over.autostart as AutostartState) }),
    ...(over.codesign === undefined
      ? {}
      : { codesign: (): Promise<CodesignState> => Promise.resolve(over.codesign as CodesignState) }),
  });
  const changes: RuntimeChange[] = [];
  runtime.on("change", (k) => changes.push(k));
  if (over.start !== false) await runtime.start();
  // Idempotent: a file-level `afterEach` closes whichever harness is current,
  // and tests that never made one would otherwise fail on a stale handle.
  let closed = false;
  return {
    runtime,
    source,
    db,
    policy,
    changes,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** The subset of `SettingsStore` the tray and the IPC layer actually call. */
export function fakeSettings(over: Partial<MainSettings> = {}): {
  all(): Readonly<MainSettings>;
  get<K extends keyof MainSettings>(k: K): MainSettings[K];
  set<K extends keyof MainSettings>(k: K, v: MainSettings[K]): Promise<void>;
  patch(v: Partial<MainSettings>): Promise<MainSettings>;
} {
  let data: MainSettings = { ...SETTINGS_DEFAULTS, ...over };
  return {
    all: () => data,
    get: (k) => data[k],
    set: async (k, v) => {
      data = { ...data, [k]: v };
    },
    patch: async (v) => {
      data = { ...data, ...v };
      return data;
    },
  };
}

export interface StoredRow {
  id: string;
  started_at_ms: number;
  ended_at_ms: number;
  last_signal_at_ms: number;
  duration_s: number;
  end_reason: string;
  jiggler_s: number;
  camera_s: number;
  key_events: number;
  mouse_events: number;
}

export function rows(db: DatabaseSync): StoredRow[] {
  return db
    .prepare(
      `SELECT id, started_at_ms, ended_at_ms, last_signal_at_ms, duration_s, end_reason,
              jiggler_s, camera_s, key_events, mouse_events
         FROM work_interval ORDER BY started_at_ms, ended_at_ms`,
    )
    .all() as unknown as StoredRow[];
}
