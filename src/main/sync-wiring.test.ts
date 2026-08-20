/**
 * THE TEST THAT WOULD HAVE CAUGHT THE GAP.
 *
 * `src/sync/` was fully implemented and had a hundred passing tests while
 * nothing in `src/main/` imported it. Every one of those tests called `flush()`
 * itself, so all of them stayed green over an app that never called it at all.
 * A suite that only ever pulls the lever cannot notice that the lever is
 * attached to nothing.
 *
 * So this file asserts the ATTACHMENT, not the mechanism:
 *
 *   closing an interval reaches the flusher
 *   launch flushes, then pulls
 *   resume flushes, then pulls
 *   the watchdog tick carries the silence alarm
 *   the doctor reports the sync layer's real numbers
 *
 * Two of them run against a recording seam, which pins the call sites exactly.
 * The rest run the REAL service against `test/sync/fake-cloud.ts` — the
 * deployed Worker over a `node:sqlite` D1 double — so a row that "reached the
 * cloud" reached the real routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PowerMonitor } from "electron";

import { MIN, T0, makeHarness, rows, type Harness } from "../../test/helpers/runtime";
import { BASE_URL, FakeCloud, MACHINE_WORK, TOKEN_WORK } from "../../test/sync/fake-cloud";
import { TOKEN_PERSONAL } from "../../test/sync/fake-cloud";
import { pendingCount } from "../store/intervals";
import { setSyncState } from "../store/sync-state";
import { SILENCE_MS } from "../sync/backup";
import { wirePowerMonitor } from "./bootstrap";
import { createSyncService, resolveSyncConfig, type SyncService } from "./sync";
import { NOT_CONFIGURED, type SyncSeam, type SyncSnapshot } from "./sync-seam";

let h: Harness;
const dirs: string[] = [];
const services: SyncService[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wwb-wiring-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  // Stop every flusher BEFORE the database it reads from is closed.
  for (const s of services.splice(0)) await s.stop();
  h?.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Advance the clock AND the timers together, so `Date.now()` and the deadline agree. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
  vi.advanceTimersByTime(ms);
}

/**
 * Drain the microtask queue until `cond` holds.
 *
 * Bounded by TURNS rather than by wall clock, and deliberately so: everything
 * this waits on is CPU-only — `node:sqlite` behind promises and a fake fetch
 * that never leaves the process — so the number of turns is a property of the
 * code, not of how loaded the machine is. A wall-clock bound would be the
 * load-sensitive choice here, not the safe one.
 */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error(`the app never ${what}`);
}

interface Recorder {
  seam: SyncSeam;
  calls: string[];
}

/** A seam that records what the app asked of it, and asks nothing of a network. */
function recordingSeam(): Recorder {
  const calls: string[] = [];
  const snapshot: SyncSnapshot = {
    sync: {
      configured: true,
      pendingRows: 0,
      lastFlushOkMs: T0,
      lastFlushError: null,
      lastPullMs: T0,
      lastPullError: null,
      watermark: 7,
      lastCloudWriteMs: T0,
      silentForMs: 0,
    },
    fingerprint: {
      checkedAtMs: T0,
      matched: true,
      localCount: 1,
      cloudCount: 1,
      localSha: "abc",
      cloudSha: "abc",
    },
    backup: { lastPath: "/tmp/wwb.sqlite", lastAtMs: T0, ageDays: 0, destination: "icloud", kept: 1 },
  };
  return {
    calls,
    seam: {
      flush: () => {
        calls.push("flush");
        return Promise.resolve({
          ok: true,
          attempted: 1,
          confirmed: 1,
          pendingAfter: 0,
          error: null,
          atMs: Date.now(),
        });
      },
      health: () => ({ configured: true, silentForMs: 0, fingerprintMatched: true }),
      snapshot: () => {
        calls.push("snapshot");
        return snapshot;
      },
      pollSilence: () => calls.push("pollSilence"),
      stop: () => {
        calls.push("stop");
        return Promise.resolve();
      },
    },
  };
}

/**
 * The real service, against the real Worker over a fake network.
 *
 * Returned as a factory because it needs the harness's own database, and that
 * does not exist until `makeHarness` has run. The service is registered for
 * teardown at construction, so no flusher can outlive the test that made it —
 * and nothing can still be reading the database when it is closed.
 */
function realSync(
  cloud: FakeCloud,
  over: { configured?: boolean } = {},
): { make: (db: DatabaseSync) => SyncService; get: () => SyncService } {
  let made: SyncService | null = null;
  return {
    make: (db) => {
      const resolved = resolveSyncConfig(
        over.configured === false ? "" : BASE_URL,
        over.configured === false ? null : TOKEN_PERSONAL,
      );
      const service = createSyncService({
        db,
        config: resolved.config,
        configError: resolved.error,
        appVersion: "0.0.0-test",
        tz: "UTC",
        backupDir: tmp(),
        fetchImpl: cloud.fetch,
      });
      services.push(service);
      made = service;
      return service;
    },
    get: () => {
      if (made === null) throw new Error("realSync: the harness was never built");
      return made;
    },
  };
}

// ── the call sites, pinned ──────────────────────────────────────────────────

describe("the wire", () => {
  it("closing an interval reaches the flusher", async () => {
    const rec = recordingSeam();
    h = await makeHarness({ sync: rec.seam });

    h.source.key(Date.now());
    expect(rec.calls).toEqual([]);

    // Fifteen minutes of nothing closes the interval at the last real signal.
    advance(16 * MIN);

    expect(rows(h.db)).toHaveLength(1);
    // `docs/ARCHITECTURE.md` §5: flush on interval close. Not on the next tray
    // refresh, not at the next launch — the row reaches the outbox and the
    // drain starts in the same tick.
    expect(rec.calls).toEqual(["flush"]);
  });

  it("does not flush when nothing closed", async () => {
    const rec = recordingSeam();
    h = await makeHarness({ sync: rec.seam });
    h.source.key(Date.now());
    advance(MIN);
    h.source.key(Date.now());
    advance(MIN);
    expect(rows(h.db)).toHaveLength(0);
    expect(rec.calls).toEqual([]);
  });

  it("carries the silence alarm on the watchdog tick, not on a sixth timer", async () => {
    const rec = recordingSeam();
    h = await makeHarness({ sync: rec.seam });
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());
    expect(rec.calls).toContain("pollSilence");
  });

  it("stops the flusher on quit, before anything can close the database", async () => {
    const rec = recordingSeam();
    h = await makeHarness({ sync: rec.seam });
    h.source.key(Date.now());
    await h.runtime.stop("app_quit");
    // A final best-effort flush, and THEN a stop that waits for it. `cancel()`
    // would not be enough: a drain past its first `await` still writes
    // `synced_at_ms` into a database somebody is about to close.
    expect(rec.calls).toEqual(["flush", "stop"]);
  });
});

// ── the same wires, with the real sync layer behind them ────────────────────

describe("an interval that closes, end to end", () => {
  it("is flushed to the cloud without anyone asking", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });

    h.source.key(Date.now());
    advance(16 * MIN);
    expect(rows(h.db)).toHaveLength(1);

    await until(() => cloud.count() === 1, "uploaded the closed interval");
    expect(pendingCount(h.db)).toBe(0);
    expect(cloud.ids()).toEqual(["iv-0"]);
  });

  it("and the other Mac's rows come back on the pull that follows", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });

    await cloud.fetch(`${BASE_URL}/intervals`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_WORK}`, "content-type": "application/json" },
      body: JSON.stringify({
        rows: [
          {
            id: "from-the-work-mac",
            machine_id: MACHINE_WORK,
            started_at_ms: T0 - 7_200_000,
            ended_at_ms: T0 - 3_600_000,
            duration_s: 3600,
            end_reason: "idle_timeout",
            tz: "UTC",
            local_date: "2023-11-14",
            key_events: 100,
            mouse_events: 40,
            camera_s: 0,
            jiggler_s: 0,
            app_version: "0.0.0-test",
            schema_v: 1,
            closed_local_ms: T0 - 3_500_000,
            server_ms: null,
          },
        ],
      }),
    });

    h.source.key(Date.now());
    advance(16 * MIN);

    await until(
      () => rows(h.db).some((r) => r.id === "from-the-work-mac"),
      "ingested the other Mac's row",
    );
    // Pulled rows are synced by definition and must never re-enter the outbox.
    expect(pendingCount(h.db)).toBe(0);
  });

  it("launch flushes and then pulls", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });
    const sync = svc.get();

    h.source.key(Date.now());
    advance(16 * MIN);
    await until(() => cloud.count() === 1, "uploaded the closed interval");
    const before = cloud.calls.length;

    // Relaunch: the same database, a fresh cycle.
    await sync.runCycle("launch");

    const since = cloud.calls.slice(before);
    expect(since.some((c) => c.method === "GET" && c.path === "/intervals")).toBe(true);
    // …and a heartbeat, so the 72-hour alarm means something during a
    // fortnight in which nothing was typed.
    expect(since.some((c) => c.path === "/heartbeat")).toBe(true);
  });

  it("resume flushes and pulls, and re-evaluates the deadline first", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });
    const sync = svc.get();

    const order: string[] = [];
    const realResume = h.runtime.onResume.bind(h.runtime);
    h.runtime.onResume = async (a, b) => {
      order.push("onResume");
      await realResume(a, b);
    };

    const handlers = new Map<string, Array<() => void>>();
    wirePowerMonitor({
      powerMonitor: {
        on: (event: string, cb: () => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), cb]);
          return undefined as never;
        },
      } as unknown as Pick<PowerMonitor, "on">,
      runtime: h.runtime,
      tray: null,
      sync,
    });

    // Type for two minutes, sleep for three hours, wake up.
    h.source.key(Date.now());
    advance(2 * MIN);
    for (const cb of handlers.get("suspend") ?? []) cb();
    advance(3 * 60 * MIN);
    for (const cb of handlers.get("resume") ?? []) cb();

    // ORDER MATTERS: the deadline is re-evaluated — closing the interval at the
    // PRE-SLEEP signal — before the flush, so the closed row is already in the
    // outbox when the first flush after waking runs.
    await until(
      () => cloud.count() === 1 && cloud.pullSince().length > 0,
      "flushed and pulled on wake",
    );
    expect(order).toEqual(["onResume"]);

    // The row was closed at the LAST REAL SIGNAL, not at wake time. Three
    // hours of sleep are not three hours of work.
    const stored = rows(h.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.ended_at_ms).toBe(T0);

    // Uploaded exactly once, whatever the interleaving: the drain is
    // single-flight and the ids are client-minted, so a wake cannot duplicate a
    // row however many callers ask for a flush at the same moment.
    expect(cloud.postCount()).toBe(1);
  });
});

// ── the doctor ──────────────────────────────────────────────────────────────

describe("the doctor", () => {
  it("reports the sync layer's real numbers, not a placeholder", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });
    const sync = svc.get();

    h.source.key(Date.now());
    advance(16 * MIN);
    await until(() => cloud.count() === 1, "uploaded the closed interval");
    await sync.runCycle("launch");

    const report = await h.runtime.doctor();

    expect(report.sync.configured).toBe(true);
    expect(report.sync.pendingRows).toBe(0);
    expect(report.sync.lastFlushOkMs).not.toBeNull();
    expect(report.sync.lastPullMs).not.toBeNull();
    expect(report.sync.watermark).toBeGreaterThan(0);
    expect(report.sync.lastCloudWriteMs).not.toBeNull();
    expect(report.sync.silentForMs).not.toBeNull();
    // Backup layers 2 and 3, reported rather than hardcoded to null.
    expect(report.fingerprint.matched).toBe(true);
    expect(report.fingerprint.localCount).toBe(1);
    expect(report.backup.lastPath).not.toBeNull();
    expect(report.backup.destination).toBe("documents");

    // The three strings this branch exists to delete.
    expect(JSON.stringify(report)).not.toContain("not wired");
  });

  it("reports 'not configured' as its own state, and nothing degraded", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud, { configured: false });
    h = await makeHarness({ sync: svc.make });

    h.source.key(Date.now());
    advance(16 * MIN);
    await until(() => pendingCount(h.db) === 1, "wrote the closed interval");

    const report = await h.runtime.doctor();
    expect(report.sync.configured).toBe(false);
    expect(report.sync.pendingRows).toBe(1);
    expect(report.sync.lastFlushError).toBeNull();
    // Not a failure, so not a warning either: no network was touched and the
    // menu bar wears no ⚠︎.
    expect(cloud.calls).toEqual([]);
    expect(h.runtime.liveStatus().degraded).toEqual([]);

    const flushed = await h.runtime.flushNow();
    expect(flushed.ok).toBe(false);
    expect(flushed.error).toBe(NOT_CONFIGURED);
    // Tracking is entirely unaffected: the row is here, at the last real signal.
    expect(rows(h.db)).toHaveLength(1);
  });

  it("does not slow tracking down when unconfigured", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud, { configured: false });
    h = await makeHarness({ sync: svc.make });

    // Ten intervals, closed back to back. Nothing here may block, throw, or
    // reach a network that does not exist.
    for (let i = 0; i < 10; i++) {
      h.source.key(Date.now());
      advance(16 * MIN);
    }
    expect(rows(h.db)).toHaveLength(10);
    expect(pendingCount(h.db)).toBe(10);
    expect(cloud.calls).toEqual([]);
  });

  it("raises the 72-hour silence alarm through the watchdog, once configured", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });

    setSyncState(h.db, "last_cloud_write_ms", String(Date.now() - SILENCE_MS - MIN));
    h.runtime.onWatchdogTick(h.source.probe(), Date.now());

    // Backup layer 4, loud in the menu bar: this is what catches a free-tier
    // policy change in 2031 that nobody is reading email from Cloudflare about.
    expect(h.runtime.liveStatus().degraded).toContain("sync_silent_72h");
  });

  it("raises a fingerprint mismatch — the layer that catches SILENT loss", async () => {
    const cloud = new FakeCloud();
    const svc = realSync(cloud);
    h = await makeHarness({ sync: svc.make });
    const sync = svc.get();

    h.source.key(Date.now());
    advance(16 * MIN);
    await until(() => cloud.count() === 1, "uploaded the closed interval");

    cloud.wipe();
    await sync.runCycle("launch");

    expect(h.runtime.liveStatus().degraded).toContain("fingerprint_mismatch");
    expect((await h.runtime.doctor()).fingerprint.matched).toBe(false);
  });
});
