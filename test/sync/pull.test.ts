/**
 * The pull watermark — AGENTS.md #9.
 *
 * The test this file exists for is `a row whose seq became visible out of order
 * is not skipped`. `seq` is an AUTOINCREMENT identity, and a reader can see 105
 * committed while 104 is still in flight; a strict `seq > watermark` walks past
 * 104 and never comes back for it. Nothing in the product would ever report
 * that. The 200-row overlap is what makes it impossible, so it is asserted two
 * ways here: the row is recovered, and the range read is proved to have started
 * behind the watermark.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createWorkerClient, type WorkerClient } from "../../src/sync/client";
import { pull, PULL_OVERLAP } from "../../src/sync/pull";
import { countIntervals, pendingRows } from "../../src/store/intervals";
import { DEFAULT_POLICY } from "../../src/store/policy";
import { byMachine } from "../../src/store/queries";
import {
  getSyncState,
  readMachines,
  setSyncState,
  upsertMachine,
} from "../../src/store/sync-state";
import { makeRow, openTestDb, t } from "../fakes/seed-db";
import { BASE_URL, FakeCloud, MACHINE_B, TOKEN_A, TOKEN_B } from "./fake-cloud";

/** A client speaking for "the other Mac" — the work token, the work machine id. */
function other(cloud: FakeCloud): WorkerClient {
  return createWorkerClient({ baseUrl: BASE_URL, token: TOKEN_B, fetchImpl: cloud.fetch });
}

/** Fill the cloud from "the other Mac", one POST per 200 rows. */
async function seedCloud(cloud: FakeCloud, count: number, prefix = "w"): Promise<string[]> {
  const client = other(cloud);
  const ids: string[] = [];
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    ids.push(id);
    const minute = i % 60;
    const hour = 8 + Math.floor(i / 60);
    return makeRow({
      id,
      machineId: "work",
      start: `2026-08-17T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
      end: `2026-08-17T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:30Z`,
    });
  });
  for (let i = 0; i < rows.length; i += 200) {
    await client.postIntervals(rows.slice(i, i + 200));
  }
  cloud.calls.length = 0; // the seeding is not part of what a test asserts
  return ids;
}

function local(cloud: FakeCloud): { db: DatabaseSync; client: WorkerClient } {
  return {
    db: openTestDb(),
    client: createWorkerClient({
      baseUrl: BASE_URL,
      token: TOKEN_A,
      fetchImpl: cloud.fetch,
    }),
  };
}

describe("pull", () => {
  it("ingests the other machine's rows and does not put them in our outbox", async () => {
    const cloud = new FakeCloud();
    const ids = await seedCloud(cloud, 5);
    const { db, client } = local(cloud);

    const res = await pull(db, client, { nowMs: () => 4_242 });

    expect(res.ingested).toBe(5);
    expect(res.watermark).toBe(5);
    expect(countIntervals(db)).toBe(5);
    // A pulled row is in the cloud by definition. If it landed in the outbox,
    // the two Macs would upload each other's history to each other forever.
    expect(pendingRows(db)).toHaveLength(0);
    const rows = db
      .prepare("SELECT id, machine_id, cloud_seq, synced_at_ms, last_signal_at_ms, ended_at_ms FROM work_interval ORDER BY id")
      .all() as Array<Record<string, number | string>>;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.every((r) => r.machine_id === MACHINE_B)).toBe(true);
    expect(rows.every((r) => r.synced_at_ms === 4_242)).toBe(true);
    expect(rows.map((r) => r.cloud_seq)).toEqual([1, 2, 3, 4, 5]);
    // The cloud has no last_signal_at_ms column; ingest re-derives it, which is
    // what lets the local CHECK constraint hold over the other Mac's rows.
    expect(rows.every((r) => r.last_signal_at_ms === r.ended_at_ms)).toBe(true);
  });

  it("starts 200 rows behind the watermark, never at it", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 300);
    const { db, client } = local(cloud);

    await pull(db, client);
    expect(getSyncState(db, "pull_watermark")).toBe("300");
    cloud.calls.length = 0;

    await pull(db, client);

    expect(cloud.pullSince()).toEqual([300 - PULL_OVERLAP]);
  });

  it("does not skip a row whose seq became visible out of order", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 300);
    const { db, client } = local(cloud);

    // seq 250 is committed but not yet visible to a range read — exactly what
    // an AUTOINCREMENT identity does under concurrent inserts.
    cloud.hiddenSeqs.add(250);
    const first = await pull(db, client);

    expect(first.watermark).toBe(300);
    expect(countIntervals(db)).toBe(299);
    expect(db.prepare("SELECT id FROM work_interval WHERE cloud_seq = 250").all()).toEqual(
      [],
    );

    // It becomes visible a moment later. Without the overlap the next pull
    // would start at 300 and this row would be lost for good.
    cloud.hiddenSeqs.delete(250);
    const second = await pull(db, client);

    expect(second.ingested).toBe(1);
    expect(countIntervals(db)).toBe(300);
    expect(cloud.pullSince().at(-1)).toBe(100);
  });

  it("re-reading the overlap ingests nothing the second time", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 50);
    const { db, client } = local(cloud);

    const first = await pull(db, client);
    const second = await pull(db, client);
    const third = await pull(db, client);

    expect(first.ingested).toBe(50);
    expect(second).toMatchObject({ ingested: 0, received: 50, watermark: 50 });
    expect(third.ingested).toBe(0);
    expect(countIntervals(db)).toBe(50);
  });

  it("pages until a short page, advancing to MAX(seq) each time", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 250);
    const { db, client } = local(cloud);

    const res = await pull(db, client, { pageSize: 100 });

    expect(res).toMatchObject({ ingested: 250, watermark: 250, pages: 3 });
    expect(cloud.pullSince()).toEqual([0, 100, 200]);
    expect(countIntervals(db)).toBe(250);
  });

  it("stops on an empty cloud without touching the watermark", async () => {
    const cloud = new FakeCloud();
    const { db, client } = local(cloud);

    const res = await pull(db, client);

    expect(res).toMatchObject({ ingested: 0, received: 0, watermark: 0, pages: 1 });
    expect(getSyncState(db, "pull_watermark")).toBeNull();
  });

  it("persists the watermark per page, so a crash mid-pull resumes correctly", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 150);
    const { db, client } = local(cloud);

    // A page size of 50 with a client that dies after the second page.
    let pages = 0;
    const dyingClient: WorkerClient = {
      ...client,
      getIntervals: async (since, limit) => {
        if (pages++ === 2) throw new TypeError("fetch failed");
        return client.getIntervals(since, limit);
      },
    };
    await expect(pull(db, dyingClient, { pageSize: 50 })).rejects.toThrow(/fetch failed/);

    expect(getSyncState(db, "pull_watermark")).toBe("100");
    expect(countIntervals(db)).toBe(100);

    const resumed = await pull(db, client, { pageSize: 50 });
    expect(resumed.watermark).toBe(150);
    expect(countIntervals(db)).toBe(150);
  });

  it("treats a corrupt watermark as zero rather than skipping everything below it", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 10);
    const { db, client } = local(cloud);
    setSyncState(db, "pull_watermark", "not-a-number");

    const res = await pull(db, client);

    expect(cloud.pullSince()).toEqual([0]);
    expect(res.ingested).toBe(10);
  });

  it("never moves the watermark backwards", async () => {
    const cloud = new FakeCloud();
    await seedCloud(cloud, 10);
    const { db, client } = local(cloud);
    await pull(db, client);

    // A page that is entirely inside the overlap cannot lower the mark.
    const res = await pull(db, client);

    expect(res.watermark).toBe(10);
    expect(getSyncState(db, "pull_watermark")).toBe("10");
  });
});

/**
 * The other Mac's NAME.
 *
 * Pulling intervals alone leaves them anonymous: `work_interval` carries
 * `machine_id` and never a label, so without this half the breakdown renders
 * the other Mac as a bare IOPlatformUUID forever, with nothing to notice.
 */
describe("pull: machine labels", () => {
  it("brings the other machine's name back, and byMachine uses it", async () => {
    const cloud = new FakeCloud();
    // One countable hour on the other Mac, uploaded by the other Mac, so the
    // row arrives here stamped with the WORK machine id by the Worker.
    await other(cloud).postIntervals([
      makeRow({
        id: "w-long",
        machineId: "ignored — the Worker stamps it from the token",
        start: "2026-08-17T09:00:00Z",
        end: "2026-08-17T10:00:00Z",
      }),
    ]);
    await other(cloud).heartbeat({ label: "The loft mini", appVersion: "0.1.0" });
    const { db, client } = local(cloud);

    // Before the pull, this mirror has never heard of that machine.
    expect(readMachines(db)).toEqual([]);

    const res = await pull(db, client);

    expect(res.machines).toBe(1);
    expect(res.machinesError).toBeNull();
    expect(readMachines(db)).toEqual([
      {
        machineId: MACHINE_B,
        label: "The loft mini",
        osVersion: null,
        appVersion: "0.1.0",
        lastSeenMs: expect.any(Number),
      },
    ]);
    // The interval and the label arrived over two different routes; the LEFT
    // JOIN is what puts them together. Without the machine row this reads back
    // as a raw IOPlatformUUID.
    expect(byMachine(db, DEFAULT_POLICY, "UTC", t("2026-08-19T12:00:00Z"))[0]).toMatchObject({
      machineId: MACHINE_B,
      label: "The loft mini",
      hours: 1,
    });
  });

  it("lets MAX(last_seen_ms) settle a conflict, not arrival order", async () => {
    const cloud = new FakeCloud();
    await other(cloud).heartbeat({ label: "MacBook Pro" });
    const { db, client } = local(cloud);
    await pull(db, client);
    const pulledAt = readMachines(db)[0]!.lastSeenMs;

    // This Mac renamed that machine locally at a LATER instant than the cloud
    // row was stamped — which is exactly the shape of a rename made offline,
    // where the heartbeat has not gone out yet. Re-pulling the older cloud row
    // must not revert it.
    upsertMachine(db, {
      machineId: MACHINE_B,
      label: "The loft mini",
      lastSeenMs: pulledAt + 60_000,
    });

    await pull(db, client);

    expect(readMachines(db)[0]?.label).toBe("The loft mini");
    expect(readMachines(db)[0]?.lastSeenMs).toBe(pulledAt + 60_000);
  });

  it("takes a NEWER cloud label over an older local one", async () => {
    const cloud = new FakeCloud();
    const { db, client } = local(cloud);
    upsertMachine(db, { machineId: MACHINE_B, label: "stale", lastSeenMs: 1 });
    await other(cloud).heartbeat({ label: "The loft mini" });

    await pull(db, client);

    expect(readMachines(db)[0]?.label).toBe("The loft mini");
  });

  it("reports a machine read that failed instead of failing the interval pull", async () => {
    // A Worker deployed before `GET /machines` existed answers 404. Labels are
    // cosmetic; the hours are not, and they are already ingested by this point.
    // So this is REPORTED, and `src/main/sync.ts` logs it — never swallowed,
    // and never allowed to lose a row.
    const cloud = new FakeCloud();
    await seedCloud(cloud, 4);
    const { db } = local(cloud);
    const client = {
      ...createWorkerClient({ baseUrl: BASE_URL, token: TOKEN_A, fetchImpl: cloud.fetch }),
      getMachines: () => Promise.reject(new Error("GET /machines → 404")),
    };

    const res = await pull(db, client);

    expect(res.ingested).toBe(4);
    expect(countIntervals(db)).toBe(4);
    expect(res.machines).toBe(0);
    expect(res.machinesError).toMatch(/404/);
    expect(getSyncState(db, "pull_watermark")).toBe("4");
  });
});
