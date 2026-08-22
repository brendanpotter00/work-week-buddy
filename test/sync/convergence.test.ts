/**
 * Two Macs, one cloud — the end-to-end gates from `docs/IMPL_STORE_SYNC.md` §9.
 *
 *   two machines converge   200 interleaved pushes and pulls, one machine
 *                           offline for a simulated three weeks ⇒ identical
 *                           interval sets
 *   wipe the cloud          truncate it, mark the local rows unsynced, flush
 *                           ⇒ the cloud is fully reconstructed
 *
 * The interleaving is driven by a seeded PRNG, so a failure here is a bug
 * somebody can reproduce rather than a flake somebody re-runs.
 *
 * The cloud is the real Worker over real SQLite. Convergence therefore rests on
 * the deployed `ON CONFLICT(id) DO NOTHING`, the real presence read-back and
 * the real `seq` ordering — not on a fake that was written to agree with the
 * client.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createWorkerClient } from "../../src/sync/client";
import type { Flusher } from "../../src/sync/flush";
import { pull } from "../../src/sync/pull";
import { localFingerprint } from "../../src/sync/fingerprint";
import { insertClosed } from "../../src/store/intervals";
import { makeRow, openTestDb } from "../fakes/seed-db";
import { testFlusher } from "./flusher";
import {
  BASE_URL,
  FakeCloud,
  MACHINE_A,
  MACHINE_B,
  TOKEN_A,
  TOKEN_B,
} from "./fake-cloud";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-08-03T09:00:00Z"); // a Monday

/** The payload every copy of a row must agree on, byte for byte. */
const PAYLOAD_SQL = `SELECT id, machine_id, started_at_ms, ended_at_ms, last_signal_at_ms,
        duration_s, end_reason, tz, local_date, key_events, mouse_events,
        camera_s, jiggler_s, app_version, schema_v, closed_local_ms, cloud_seq
   FROM work_interval ORDER BY id`;

/** Deterministic PRNG. A converge test that flakes teaches nobody anything. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Machine {
  readonly name: string;
  readonly machineId: string;
  readonly db: DatabaseSync;
  readonly flusher: Flusher;
  readonly client: ReturnType<typeof createWorkerClient>;
  offline: boolean;
  recorded: number;
}

function machine(cloud: FakeCloud, name: string, token: string, machineId: string): Machine {
  const db = openTestDb();
  const m: Machine = {
    name,
    machineId,
    db,
    offline: false,
    recorded: 0,
    client: createWorkerClient({
      baseUrl: BASE_URL,
      token,
      // Per-machine airplane mode: one Mac can be off the network for three
      // weeks while the other keeps working.
      fetchImpl: async (input, init) => {
        if (m.offline) throw new TypeError("fetch failed");
        return cloud.fetch(input, init);
      },
    }),
    flusher: undefined as unknown as Flusher,
  };
  return Object.assign(m, {
    flusher: testFlusher({
      db,
      client: m.client,
      // No retry timers in this test: every flush is driven explicitly, so a
      // stray timer would make the interleaving a lie.
      scheduleTimer: () => null,
      cancelTimer: () => undefined,
    }),
  });
}

function record(m: Machine, dayIndex: number): void {
  const n = m.recorded++;
  const startedAtMs = START + dayIndex * DAY_MS + n * 90_000;
  insertClosed(
    m.db,
    makeRow({
      id: `${m.name}-${String(n).padStart(4, "0")}`,
      // The IOPlatformUUID, which is also what the Worker is configured to
      // stamp for this machine's token. See the invariant test below: if these
      // two ever disagree, the mirrors converge on every column but this one.
      machineId: m.machineId,
      start: new Date(startedAtMs).toISOString(),
      end: new Date(startedAtMs + 45_000).toISOString(),
      keyEvents: n * 3,
      mouseEvents: n,
    }),
  );
}

function payload(db: DatabaseSync): unknown[] {
  return db.prepare(PAYLOAD_SQL).all();
}

function ids(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM work_interval ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** Flush then pull, both machines, until nothing moves. */
async function settle(a: Machine, b: Machine): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (const m of [a, b]) {
      await m.flusher.flush();
      await pull(m.db, m.client);
    }
  }
}

describe("two machines and one cloud", () => {
  it("converge on identical interval sets after three weeks apart", async () => {
    const cloud = new FakeCloud();
    const personal = machine(cloud, "personal", TOKEN_A, MACHINE_A);
    const work = machine(cloud, "work", TOKEN_B, MACHINE_B);
    const rnd = mulberry32(20260819);

    for (let step = 0; step < 200; step++) {
      const day = Math.floor(step / 8);
      // The work Mac is off the network for three weeks: a conference, a
      // firewall, a holiday. Its outbox just grows.
      work.offline = day < 21;

      const who = rnd() < 0.5 ? personal : work;
      const roll = rnd();
      if (roll < 0.5) record(who, day);
      else if (roll < 0.8) await who.flusher.flush();
      else {
        try {
          await pull(who.db, who.client);
        } catch {
          // Offline. Exactly as in production: nothing to do, nothing to log.
        }
      }
    }

    expect(work.recorded).toBeGreaterThan(10);
    expect(personal.recorded).toBeGreaterThan(10);
    // Before the reunion the two mirrors genuinely differ.
    expect(ids(personal.db)).not.toEqual(ids(work.db));

    work.offline = false;
    await settle(personal, work);

    const total = personal.recorded + work.recorded;
    expect(ids(personal.db)).toEqual(ids(work.db));
    expect(ids(personal.db)).toEqual(cloud.ids());
    expect(cloud.count()).toBe(total);
    // Identical row for row, not merely the same ids.
    expect(payload(personal.db)).toEqual(payload(work.db));
    // Nothing was uploaded twice: the cloud has exactly one row per id.
    expect(new Set(cloud.ids()).size).toBe(total);
    // Both outboxes are empty and the weekly check agrees with the cloud.
    expect(personal.flusher.hasPending()).toBe(false);
    expect(work.flusher.hasPending()).toBe(false);
    const remote = await personal.client.fingerprint();
    expect(localFingerprint(personal.db).sha256).toBe(remote.sha256);
    expect(localFingerprint(work.db).sha256).toBe(remote.sha256);
    expect(remote.count).toBe(total);
  });

  it("needs the local machine id to equal the Worker's stamp, or attribution splits", async () => {
    const cloud = new FakeCloud();
    const personal = machine(cloud, "personal", TOKEN_A, MACHINE_A);
    const work = machine(cloud, "work", TOKEN_B, MACHINE_B);

    // A machine whose local id is NOT the one the Worker stamps for its token —
    // `MACHINE_ID_PERSONAL` never set, say, or set to the wrong Mac's UUID at
    // bring-up. Every column converges except the one nobody would check.
    insertClosed(
      personal.db,
      makeRow({
        id: "misconfigured-0000",
        machineId: "a-label-the-worker-has-never-heard-of",
        start: "2026-08-03T09:00:00Z",
        end: "2026-08-03T09:10:00Z",
      }),
    );
    await settle(personal, work);

    expect(ids(personal.db)).toEqual(ids(work.db)); // the row itself is fine
    const localSide = personal.db
      .prepare("SELECT machine_id FROM work_interval WHERE id = 'misconfigured-0000'")
      .get();
    const otherSide = work.db
      .prepare("SELECT machine_id FROM work_interval WHERE id = 'misconfigured-0000'")
      .get();
    expect(localSide).toMatchObject({ machine_id: "a-label-the-worker-has-never-heard-of" });
    expect(otherSide).toMatchObject({ machine_id: MACHINE_A });
    // Hence T7.2's bring-up step: set MACHINE_ID_PERSONAL / MACHINE_ID_WORK to
    // each Mac's IOPlatformUUID, the same value the app writes locally. Nothing
    // in the sync layer can detect this on its own — the presence answer
    // carries only id and seq — so it is a deploy-time invariant, checked here.
  });

  it("attributes each row to the Mac that recorded it, from its token", async () => {
    const cloud = new FakeCloud();
    const personal = machine(cloud, "personal", TOKEN_A, MACHINE_A);
    const work = machine(cloud, "work", TOKEN_B, MACHINE_B);
    record(personal, 0);
    record(work, 0);

    await settle(personal, work);

    const byId = new Map(cloud.rows().map((r) => [r.id, r.machine_id]));
    expect(byId.get("personal-0000")).toBe(MACHINE_A);
    expect(byId.get("work-0000")).toBe(MACHINE_B);
  });
});

describe("total vendor loss", () => {
  it("rebuilds the whole cloud from one mirror's outbox", async () => {
    const cloud = new FakeCloud();
    const personal = machine(cloud, "personal", TOKEN_A, MACHINE_A);
    const work = machine(cloud, "work", TOKEN_B, MACHINE_B);
    for (let i = 0; i < 12; i++) record(personal, i % 5);
    for (let i = 0; i < 9; i++) record(work, i % 5);
    await settle(personal, work);
    const before = cloud.ids();
    expect(before).toHaveLength(21);

    // The vendor is gone, the account is closed, the free tier changed. What is
    // left is two Macs, each holding a full mirror.
    cloud.wipe();
    expect(cloud.count()).toBe(0);

    // `docs/IMPL_STORE_SYNC.md` §8, layer 1 — one statement, then the ordinary
    // flush loop. There is no restore path to write, because there is no queue
    // table to rebuild: the mirror IS the outbox.
    personal.db.exec("UPDATE work_interval SET synced_at_ms = NULL");
    expect(personal.flusher.hasPending()).toBe(true);

    const res = await personal.flusher.flush();

    expect(res.drained).toBe(true);
    expect(res.confirmed).toBe(21);
    expect(cloud.ids()).toEqual(before);
    expect(cloud.count()).toBe(21);
    expect(personal.flusher.hasPending()).toBe(false);
  });

  it("re-stamps rows to the rebuilding Mac — so rebuild from BOTH to keep attribution", async () => {
    const cloud = new FakeCloud();
    const personal = machine(cloud, "personal", TOKEN_A, MACHINE_A);
    const work = machine(cloud, "work", TOKEN_B, MACHINE_B);
    record(personal, 0);
    record(work, 0);
    await settle(personal, work);
    cloud.wipe();

    // A one-Mac rebuild re-uploads the OTHER Mac's rows too, and the Worker
    // stamps machine_id from the bearer token — the same forgery guard that
    // stops a stolen token faking the other Mac's hours. The rows all come
    // back; their attribution does not.
    personal.db.exec("UPDATE work_interval SET synced_at_ms = NULL");
    await personal.flusher.flush();

    expect(cloud.ids()).toEqual(["personal-0000", "work-0000"]);
    expect(new Map(cloud.rows().map((r) => [r.id, r.machine_id])).get("work-0000")).toBe(
      MACHINE_A,
    );

    // The fix is to rebuild from both Macs, each marking only its own rows:
    // `UPDATE work_interval SET synced_at_ms = NULL WHERE machine_id = <mine>`.
    // Each mirror still holds the truth about which Mac recorded what.
    cloud.wipe();
    for (const m of [personal, work]) {
      m.db
        .prepare("UPDATE work_interval SET synced_at_ms = NULL WHERE machine_id = ?")
        .run(m.machineId);
      await m.flusher.flush();
    }

    expect(new Map(cloud.rows().map((r) => [r.id, r.machine_id]))).toEqual(
      new Map([
        ["personal-0000", MACHINE_A],
        ["work-0000", MACHINE_B],
      ]),
    );
  });
});
