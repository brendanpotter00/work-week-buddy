/**
 * The outbox drain — AGENTS.md #8's test file.
 *
 * The gates in the task, one test each:
 *
 *   6 intervals recorded offline, then reconnect ⇒ all 6 land, none duplicated
 *   the server commits and the response is dropped ⇒ retry, no-op, marked once
 *   a non-2xx ⇒ `synced_at_ms` still NULL for every row
 *   after a successful drain ⇒ no backoff timer remains armed
 *
 * The cloud is the real Worker over a real SQLite (see `fake-cloud.ts`), so
 * "none duplicated" is a fact about the deployed `ON CONFLICT(id) DO NOTHING`
 * and not about a fake that was written to agree.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  BACKOFF_CAP_MS,
  BACKOFF_LADDER_MS,
  FLUSH_PAGE_SIZE,
  noteCloudWrite,
  STOPPED,
  type Flusher,
  type FlusherDeps,
  type TimerHandle,
} from "../../src/sync/flush";
import { createWorkerClient, MAX_ROWS_PER_REQUEST } from "../../src/sync/client";
import { getSyncState } from "../../src/store/sync-state";
import { makeRow, openTestDb } from "../fakes/seed-db";
import { insertClosed } from "../../src/store/intervals";
import { BASE_URL, FakeCloud, TOKEN_PERSONAL } from "./fake-cloud";
import { testFlusher } from "./flusher";

/** A scheduler you can inspect: no wall-clock waiting anywhere in this file. */
class TestTimers {
  private next = 1;
  private readonly armed = new Map<number, { fn: () => void; delayMs: number }>();

  readonly schedule = (fn: () => void, delayMs: number): TimerHandle => {
    const id = this.next++;
    this.armed.set(id, { fn, delayMs });
    return id;
  };

  readonly cancel = (handle: TimerHandle): void => {
    this.armed.delete(handle as number);
  };

  count(): number {
    return this.armed.size;
  }

  delays(): number[] {
    return [...this.armed.values()].map((t) => t.delayMs);
  }

  /**
   * Fire everything armed, then let the flush it started run to completion.
   *
   * The retry is launched as `void flush()` — deliberately, since a timer has
   * nobody to hand a promise to — so there is nothing to await. Ticking the
   * macrotask queue until `until` holds is how the test waits without a sleep.
   */
  async fireAll(until?: () => boolean): Promise<void> {
    const pending = [...this.armed.values()];
    this.armed.clear();
    for (const timer of pending) timer.fn();
    // Bound this by WALL CLOCK, not by a tick count. A fixed number of
    // macrotask ticks is load-sensitive by construction: the flush this
    // started does database work and a fake round trip, and on a busy machine
    // that legitimately needs more ticks than an idle one. Reproduced under
    // CPU load, where a 200-tick budget failed roughly one run in four.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (until === undefined || until()) return;
    }
    throw new Error("fireAll: the retry never reached the expected state");
  }
}

function intervals(db: DatabaseSync, count: number, prefix = "i"): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const hh = String(8 + Math.floor(i / 60)).padStart(2, "0");
    const mm = String(i % 60).padStart(2, "0");
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    insertClosed(
      db,
      makeRow({
        id,
        machineId: "personal",
        start: `2026-08-17T${hh}:${mm}:00Z`,
        end: `2026-08-17T${hh}:${mm}:30Z`,
      }),
    );
    ids.push(id);
  }
  return ids;
}

function pendingCount(db: DatabaseSync): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NULL").get() as {
      c: number;
    }
  ).c;
}

function syncedCount(db: DatabaseSync): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NOT NULL")
      .get() as { c: number }
  ).c;
}

interface Rig {
  readonly db: DatabaseSync;
  readonly cloud: FakeCloud;
  readonly timers: TestTimers;
  readonly flusher: Flusher;
}

function rig(overrides: Partial<FlusherDeps> = {}, fetchImpl?: typeof fetch): Rig {
  const db = openTestDb();
  const cloud = new FakeCloud();
  const timers = new TestTimers();
  const client = createWorkerClient({
    baseUrl: BASE_URL,
    token: TOKEN_PERSONAL,
    fetchImpl: fetchImpl ?? cloud.fetch,
  });
  const flusher = testFlusher({
    db,
    client,
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
    // Mid-band jitter, so a delay assertion is about the ladder and not luck.
    random: () => 0.5,
    ...overrides,
  });
  return { db, cloud, timers, flusher };
}

describe("flush — the offline hour", () => {
  it("lands all 6 intervals recorded offline, none of them twice", async () => {
    const { db, cloud, timers, flusher } = rig();
    const ids = intervals(db, 6);

    cloud.offline = true;
    const offline = await flusher.flush();

    expect(offline.drained).toBe(false);
    expect(offline.confirmed).toBe(0);
    expect(cloud.count()).toBe(0);
    expect(pendingCount(db)).toBe(6);
    expect(timers.count()).toBe(1);

    cloud.offline = false;
    await timers.fireAll(() => pendingCount(db) === 0);

    expect(cloud.count()).toBe(6);
    expect(cloud.ids()).toEqual(ids);
    expect(pendingCount(db)).toBe(0);
    expect(syncedCount(db)).toBe(6);
    // Every row carries the seq the server reported for it.
    const seqs = db
      .prepare("SELECT id, cloud_seq FROM work_interval ORDER BY id")
      .all() as Array<{ id: string; cloud_seq: number }>;
    expect(seqs.map((r) => r.cloud_seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("sends nothing at all once the outbox is empty", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 3);

    await flusher.flush();
    const posts = cloud.postCount();
    await flusher.flush();

    expect(cloud.postCount()).toBe(posts);
    expect(cloud.count()).toBe(3);
  });
});

describe("flush — a response lost after the server committed", () => {
  it("re-sends, the server no-ops, and every row ends marked exactly once", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 3);

    // The Worker runs and COMMITS. The client never sees the answer.
    cloud.dropResponses = 1;
    const lost = await flusher.flush();

    expect(lost.error).toMatch(/fetch failed/);
    // The rows are in the cloud …
    expect(cloud.count()).toBe(3);
    // … and still, correctly, in the outbox. This is the whole rule.
    expect(pendingCount(db)).toBe(3);
    expect(syncedCount(db)).toBe(0);

    const replay = await flusher.flush();

    expect(replay.confirmed).toBe(3);
    expect(cloud.count()).toBe(3); // the replay inserted nothing
    expect(cloud.ids()).toEqual(["i-0000", "i-0001", "i-0002"]);
    expect(pendingCount(db)).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(DISTINCT synced_at_ms) AS c FROM work_interval")
        .get(),
    ).toMatchObject({ c: 1 });
  });

  it("converges however many responses in a row are lost", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 3);

    cloud.dropResponses = 3;
    await flusher.flush();
    await flusher.flush();
    await flusher.flush();
    expect(pendingCount(db)).toBe(3);
    // Three commits of the same three ids. The conflict clause did the work.
    expect(cloud.count()).toBe(3);

    await flusher.flush();

    expect(cloud.count()).toBe(3);
    expect(pendingCount(db)).toBe(0);
    expect(cloud.ids()).toEqual(["i-0000", "i-0001", "i-0002"]);
  });
});

describe("flush — nothing is marked without a 200", () => {
  for (const status of [401, 413, 500]) {
    it(`leaves synced_at_ms NULL for every row on a ${String(status)}`, async () => {
      const { db, cloud, flusher } = rig();
      intervals(db, 4);
      cloud.failWithStatus = status;

      const res = await flusher.flush();

      expect(res.confirmed).toBe(0);
      expect(res.error).toContain(String(status));
      expect(pendingCount(db)).toBe(4);
      expect(syncedCount(db)).toBe(0);
      expect(getSyncState(db, "last_cloud_write_ms")).toBeNull();
    });
  }

  it("marks only the ids the server reported present, not the ids it sent", async () => {
    const cloud = new FakeCloud();
    // A server that commits all three rows but answers for only two of them.
    // The insert said three; presence says two; presence is what counts.
    const lyingFetch: typeof fetch = async (input, init) => {
      const res = await cloud.fetch(input, init);
      const url = new URL(new Request(input as RequestInfo, init).url);
      if (url.pathname !== "/intervals" || !res.ok) return res;
      const body = (await res.json()) as { present: Array<{ id: string; seq: number }> };
      return Response.json({
        ...body,
        present: body.present.filter((p) => p.id !== "i-0001"),
      });
    };
    const { db, flusher } = rig({}, lyingFetch);
    intervals(db, 3);

    await flusher.flush();

    expect(syncedCount(db)).toBe(2);
    expect(
      db.prepare("SELECT id FROM work_interval WHERE synced_at_ms IS NULL").all(),
    ).toMatchObject([{ id: "i-0001" }]);
    // The row the server would not answer for is in the cloud, and stays in the
    // outbox — the safe half of the trade. Never the other way round.
    expect(cloud.count()).toBe(3);
  });

  it("stops rather than spinning when a 200 confirms nothing", async () => {
    const cloud = new FakeCloud();
    const emptyPresence: typeof fetch = async (input, init) => {
      const res = await cloud.fetch(input, init);
      const url = new URL(new Request(input as RequestInfo, init).url);
      return url.pathname === "/intervals" && res.ok
        ? Response.json({ present: [], server_ms: 1 })
        : res;
    };
    const { db, timers, flusher } = rig({}, emptyPresence);
    intervals(db, 2);

    const res = await flusher.flush();

    expect(res.error).toBe("server confirmed no rows");
    expect(cloud.postCount()).toBe(1);
    expect(pendingCount(db)).toBe(2);
    expect(timers.count()).toBe(1);
  });
});

describe("flush — the timer exists only while pending > 0", () => {
  it("leaves no backoff timer armed after a successful drain", async () => {
    const { db, cloud, timers, flusher } = rig();
    intervals(db, 5);

    cloud.offline = true;
    await flusher.flush();
    expect(timers.count()).toBe(1);
    expect(flusher.timerArmed()).toBe(true);

    cloud.offline = false;
    const drained = await flusher.flush();

    expect(drained.drained).toBe(true);
    expect(timers.count()).toBe(0);
    expect(flusher.timerArmed()).toBe(false);
    expect(flusher.backoffMs()).toBe(0);
    expect(flusher.hasPending()).toBe(false);
  });

  it("arms nothing at all when the outbox is already empty", async () => {
    const { timers, flusher } = rig();

    const res = await flusher.flush();

    expect(res).toMatchObject({ attempted: 0, confirmed: 0, drained: true });
    expect(timers.count()).toBe(0);
  });

  it("climbs 30s → 15min and then stays there, one timer at a time", async () => {
    const { db, cloud, timers, flusher } = rig();
    intervals(db, 1);
    cloud.offline = true;

    const delays: number[] = [];
    for (let i = 0; i < BACKOFF_LADDER_MS.length + 1; i++) {
      await flusher.flush();
      delays.push(flusher.armedDelayMs()!);
      expect(timers.count()).toBe(1); // never two
    }

    expect(delays).toEqual([...BACKOFF_LADDER_MS, BACKOFF_CAP_MS]);
  });

  it("jitters each step inside ±20%", async () => {
    for (const [roll, factor] of [
      [0, 0.8],
      [1, 1.2],
    ] as const) {
      const { db, cloud, flusher } = rig({ random: () => roll });
      intervals(db, 1);
      cloud.offline = true;

      await flusher.flush();

      expect(flusher.armedDelayMs()).toBe(Math.round(BACKOFF_LADDER_MS[0]! * factor));
    }
  });

  it("resets the ladder after a success, so the next outage starts at 30s", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 1, "a");
    cloud.offline = true;
    await flusher.flush();
    await flusher.flush();
    expect(flusher.backoffMs()).toBe(60_000);

    cloud.offline = false;
    await flusher.flush();
    intervals(db, 1, "b");
    cloud.offline = true;
    await flusher.flush();

    expect(flusher.backoffMs()).toBe(30_000);
  });

  it("cancel() disarms, for quit", async () => {
    const { db, cloud, timers, flusher } = rig();
    intervals(db, 1);
    cloud.offline = true;
    await flusher.flush();

    flusher.cancel();

    expect(timers.count()).toBe(0);
    expect(flusher.timerArmed()).toBe(false);
  });
});

describe("flush — single-flight and paging", () => {
  it("returns the running drain rather than opening a second one", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 6);

    const first = flusher.flush();
    const second = flusher.flush();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(cloud.postCount()).toBe(1);
    expect(cloud.count()).toBe(6);
  });

  it("pages at the Worker's cap and never sends more in one request", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, FLUSH_PAGE_SIZE + 50);

    const res = await flusher.flush();

    expect(res.drained).toBe(true);
    const posted = cloud.calls
      .filter((c) => c.method === "POST" && c.path === "/intervals")
      .map((c) => c.rows);
    expect(posted).toEqual([MAX_ROWS_PER_REQUEST, 50]);
    expect(Math.max(...posted)).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST);
    expect(cloud.count()).toBe(FLUSH_PAGE_SIZE + 50);
  });

  it("records the moment of the last confirmed cloud write", async () => {
    const { db, flusher } = rig({ nowMs: () => 1_770_000_000_000 });
    intervals(db, 2);

    await flusher.flush();

    expect(getSyncState(db, "last_cloud_write_ms")).toBe("1770000000000");
  });

  it("noteCloudWrite lets a heartbeat answer the silence alarm too", () => {
    const db = openTestDb();
    noteCloudWrite(db, 42);
    expect(getSyncState(db, "last_cloud_write_ms")).toBe("42");
  });
});

/**
 * `cancel()` disarms. `stop()` disarms AND waits.
 *
 * The difference is the whole reason this block exists: a drain past its first
 * await still reads rows out of the database, and the backoff retry is
 * `void flush()` from inside a timer — no promise, nobody holding it, nothing
 * to await. Whoever closes the database next (⌘Q, a test's teardown) needs one
 * call that means "and nothing of yours is still running".
 */
describe("flush — stop(), so no drain outlives its database", () => {
  it("returns only once the drain already in flight has finished", async () => {
    const cloud = new FakeCloud();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const parking: typeof fetch = async (input, init) => {
      await held;
      order.push("request answered");
      return cloud.fetch(input, init);
    };
    const { db, flusher } = rig({}, parking);
    intervals(db, 2);

    const draining = flusher.flush();
    const stopping = flusher.stop().then(() => order.push("stop returned"));
    release();
    await stopping;

    // The order IS the property. Anything else means `stop()` handed back
    // control while a drain was still reading the database it is about to
    // close, which is the failure this whole file is guarding against.
    expect(order).toEqual(["request answered", "stop returned"]);
    expect((await draining).confirmed).toBe(2);
  });

  it("refuses to start a new drain, and says so rather than throwing", async () => {
    const { db, cloud, flusher } = rig();
    intervals(db, 3);

    await flusher.stop();
    const res = await flusher.flush();

    expect(res).toMatchObject({ attempted: 0, confirmed: 0, drained: false, error: STOPPED });
    expect(cloud.postCount()).toBe(0);
    expect(pendingCount(db)).toBe(3);
  });

  it("leaves a retry that fires anyway with nothing to do", async () => {
    // A timer whose callback is already queued cannot be un-fired — clearing
    // the handle is too late. So the refusal has to live in `flush()` itself,
    // and this fires the callback by hand to prove it does.
    const fired: Array<() => void> = [];
    const { db, cloud, flusher } = rig({
      scheduleTimer: (fn) => {
        fired.push(fn);
        return fired.length;
      },
      cancelTimer: () => undefined,
    });
    intervals(db, 2);
    cloud.offline = true;
    await flusher.flush();
    expect(fired).toHaveLength(1);

    await flusher.stop();
    cloud.offline = false;
    const postsBefore = cloud.postCount();
    fired[0]?.();

    expect(cloud.postCount()).toBe(postsBefore);
    expect(cloud.count()).toBe(0);
    expect(pendingCount(db)).toBe(2);
  });

  it("disarms the armed retry and resets the ladder", async () => {
    const { db, cloud, timers, flusher } = rig();
    intervals(db, 1);
    cloud.offline = true;
    await flusher.flush();
    expect(timers.count()).toBe(1);

    await flusher.stop();

    expect(timers.count()).toBe(0);
    expect(flusher.timerArmed()).toBe(false);
    expect(flusher.backoffMs()).toBe(0);
  });

  it("is idempotent, because teardown cannot know whether quit already ran", async () => {
    const { db, flusher } = rig();
    intervals(db, 1);

    await flusher.stop();
    await flusher.stop();

    expect(flusher.timerArmed()).toBe(false);
  });
});
