/**
 * What happens when the answer is nonsense.
 *
 * Every parse in the sync layer is a place where a plausible-looking wrong
 * number could enter the mirror with nothing thrown — a missing `duration_s`
 * becoming `undefined`, then `NaN`, then a Tuesday with no hours on it. And the
 * presence parse is worse than that: a row marked from a malformed answer is a
 * row deleted from the outbox that never reached the cloud, which is the exact
 * silent loss AGENTS.md #8 exists to prevent.
 *
 * So the rule for this whole layer is: anything unexpected throws, the rows
 * stay pending, and the retry happens. These tests pin that.
 */
import { describe, it, expect } from "vitest";
import { createWorkerClient } from "../../src/sync/client";
import { createFlusher } from "../../src/sync/flush";
import { pull } from "../../src/sync/pull";
import { fromCloudRow, toWireRow } from "../../src/sync/wire";
import { parseNdjson } from "../../src/sync/restore";
import { insertClosed } from "../../src/store/intervals";
import { makeRow, openTestDb } from "../fakes/seed-db";
import { BASE_URL, FakeCloud, TOKEN_PERSONAL } from "./fake-cloud";

const GOOD = toWireRow(
  makeRow({
    id: "a",
    machineId: "personal",
    start: "2026-08-17T09:00:00Z",
    end: "2026-08-17T09:10:00Z",
  }),
);

/** A cloud that answers 200 with whatever you give it. */
function answering(body: unknown, only = "/intervals"): typeof fetch {
  return async (input, init) => {
    const url = new URL(new Request(input as RequestInfo, init).url);
    if (url.pathname !== only) return new Response("not found", { status: 404 });
    return Response.json(body);
  };
}

function pendingIntervals(count: number) {
  const db = openTestDb();
  for (let i = 0; i < count; i++) {
    insertClosed(
      db,
      makeRow({
        id: `i-${String(i)}`,
        machineId: "personal",
        start: `2026-08-17T09:0${String(i)}:00Z`,
        end: `2026-08-17T09:0${String(i)}:30Z`,
      }),
    );
  }
  return db;
}

function client(fetchImpl: typeof fetch) {
  return createWorkerClient({ baseUrl: BASE_URL, token: TOKEN_PERSONAL, fetchImpl });
}

describe("a cloud row that is missing something", () => {
  it("accepts a complete row", () => {
    expect(fromCloudRow({ ...GOOD, seq: 7 }).cloudSeq).toBe(7);
  });

  it.each([
    ["duration_s", "duration_s is not a number"],
    ["ended_at_ms", "ended_at_ms is not a number"],
    ["local_date", "local_date is not text"],
    ["seq", "seq is not a number"],
  ])("throws when %s is missing", (column, message) => {
    const row: Record<string, unknown> = { ...GOOD, seq: 1 };
    delete row[column];
    expect(() => fromCloudRow(row)).toThrow(message);
  });

  it("names the row it choked on", () => {
    expect(() => fromCloudRow({ ...GOOD, seq: 1, duration_s: null })).toThrow(/'a'/);
    expect(() => fromCloudRow({ seq: 1 })).toThrow(/<no id>/);
  });

  it("rejects a number that is not one", () => {
    expect(() => fromCloudRow({ ...GOOD, seq: 1, key_events: "12" })).toThrow(/key_events/);
    expect(() => fromCloudRow({ ...GOOD, seq: Number.NaN })).toThrow(/seq/);
  });

  it("rejects a row that is not an object at all", () => {
    expect(() => fromCloudRow("nope")).toThrow(/expected an object/);
    expect(() => fromCloudRow(null)).toThrow(/expected an object/);
  });

  it("allows a null server_ms, which is what an un-stamped row has", () => {
    expect(fromCloudRow({ ...GOOD, seq: 1, server_ms: null }).serverMs).toBeNull();
  });

  it("stops the whole pull rather than ingesting half a page", async () => {
    const db = openTestDb();
    const bad = client(answering({ rows: [{ ...GOOD, seq: 1 }, { id: "b", seq: 2 }] }));

    await expect(pull(db, bad)).rejects.toThrow(/cloud row 'b'/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM work_interval").get()).toMatchObject({ c: 0 });
  });
});

describe("a presence answer that cannot be trusted", () => {
  it.each([
    ["no present array", { server_ms: 1 }],
    ["present is not an array", { present: "all of them", server_ms: 1 }],
    ["an entry with no id", { present: [{ seq: 1 }], server_ms: 1 }],
    ["an entry with an empty id", { present: [{ id: "", seq: 1 }], server_ms: 1 }],
    ["an entry with no seq", { present: [{ id: "i-0" }], server_ms: 1 }],
    ["a body that is an array", []],
    ["a body that is a string", "ok"],
  ])("leaves every row pending: %s", async (_name, body) => {
    const db = pendingIntervals(2);
    const flusher = createFlusher({
      db,
      client: client(answering(body)),
      scheduleTimer: () => null,
      cancelTimer: () => undefined,
    });

    const res = await flusher.flush();

    expect(res.confirmed).toBe(0);
    expect(res.drained).toBe(false);
    expect(res.error).toBeTruthy();
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NULL").get(),
    ).toMatchObject({ c: 2 });
  });

  it("tolerates a missing server_ms — it is a diagnostic, not the rule", async () => {
    const db = pendingIntervals(1);
    const flusher = createFlusher({
      db,
      client: client(answering({ present: [{ id: "i-0", seq: 4 }] })),
      scheduleTimer: () => null,
      cancelTimer: () => undefined,
    });

    expect((await flusher.flush()).confirmed).toBe(1);
  });

  it("throws on a malformed fingerprint rather than reporting a false match", async () => {
    await expect(client(answering({ count: 1 }, "/fingerprint")).fingerprint()).rejects.toThrow(
      /maxEndedAtMs/,
    );
  });

  it("throws on a range read that is not a page", async () => {
    await expect(client(answering({ rows: 3 })).getIntervals(0)).rejects.toThrow(/array/);
  });

  it("puts the server's message in the HttpError, truncated", async () => {
    const long = "x".repeat(500);
    const failing: typeof fetch = async () => new Response(long, { status: 500 });
    await expect(client(failing).fingerprint()).rejects.toThrow(/500: x{200}…/);
  });
});

describe("a corrupted export", () => {
  it("refuses the line and says which one", () => {
    const good = JSON.stringify(GOOD);
    expect(() => parseNdjson(`${good}\n{"id":"b"}\n`)).toThrow(/ndjson line 2/);
  });

  it("skips blank lines", () => {
    expect(parseNdjson(`\n${JSON.stringify(GOOD)}\n\n`)).toHaveLength(1);
  });

  it("leaves cloud_seq null on a row exported without one", () => {
    expect(parseNdjson(JSON.stringify(GOOD))[0]?.cloudSeq).toBeNull();
  });

  it("keeps a seq when the source had one", () => {
    expect(parseNdjson(JSON.stringify({ ...GOOD, seq: 12 }))[0]?.cloudSeq).toBe(12);
  });

  it("refuses a line that is not an object", () => {
    expect(() => parseNdjson("42\n")).toThrow(/ndjson line 1/);
  });
});

describe("the real timer, not the injected one", () => {
  it("arms and disarms a genuine setTimeout without holding the process open", async () => {
    const cloud = new FakeCloud();
    cloud.offline = true;
    const db = pendingIntervals(1);
    // No scheduleTimer override: this exercises the production default, which
    // unrefs its handle so a pending retry can never be the reason a CLI run
    // refuses to exit.
    const flusher = createFlusher({ db, client: client(cloud.fetch) });

    await flusher.flush();
    expect(flusher.timerArmed()).toBe(true);
    expect(flusher.armedDelayMs()).toBeGreaterThanOrEqual(24_000);

    flusher.cancel();
    expect(flusher.timerArmed()).toBe(false);
  });

  it("arms nothing when the outbox emptied while the request was failing", async () => {
    const db = pendingIntervals(2);
    let armed = 0;
    const raceyClient = client(async () => {
      // Another flusher — the one the interval-close effect started — drained
      // the outbox while this request was in flight. There is nothing left to
      // retry, so there must be no timer.
      db.exec("UPDATE work_interval SET synced_at_ms = 1, cloud_seq = 1");
      throw new TypeError("fetch failed");
    });
    const flusher = createFlusher({
      db,
      client: raceyClient,
      scheduleTimer: () => {
        armed++;
        return null;
      },
      cancelTimer: () => undefined,
    });

    const res = await flusher.flush();

    expect(res.error).toMatch(/fetch failed/);
    expect(res.retryInMs).toBeUndefined();
    expect(armed).toBe(0);
    expect(flusher.timerArmed()).toBe(false);
    expect(flusher.backoffMs()).toBe(0);
  });
});
