/**
 * The client, against the real Worker.
 *
 * Every assertion here is really an assertion about the contract between
 * `src/sync/wire.ts` and `worker/src/routes.ts`: same column names, same order,
 * same nullability, same dialect. A mock would agree with whatever the client
 * sent, which is precisely the bug worth catching.
 */
import { describe, it, expect } from "vitest";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  createWorkerClient,
  HttpError,
  MAX_ROWS_PER_REQUEST,
} from "../../src/sync/client";
import { toWireRow } from "../../src/sync/wire";
import { makeRow, t } from "../fakes/seed-db";
import {
  BASE_URL,
  FakeCloud,
  MACHINE_A,
  TOKEN_A,
} from "./fake-cloud";

function clientFor(cloud: FakeCloud, token = TOKEN_A) {
  return createWorkerClient({ baseUrl: BASE_URL, token, fetchImpl: cloud.fetch });
}

function interval(id: string, minute: number, machineId = "personal") {
  return makeRow({
    id,
    machineId,
    start: `2026-08-17T09:${String(minute).padStart(2, "0")}:00Z`,
    end: `2026-08-17T09:${String(minute).padStart(2, "0")}:30Z`,
    keyEvents: 12,
    mouseEvents: 3,
  });
}

/** A real collection, without asking the runner for `--expose-gc`. */
function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  try {
    (runInNewContext("gc") as () => void)();
  } finally {
    setFlagsFromString("--no-expose-gc");
  }
}

describe("the Worker client", () => {
  it("uploads a row the Worker's own SQL accepts, and reads it back present", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);

    const res = await client.postIntervals([interval("a", 0)]);

    expect(res.present).toEqual([{ id: "a", seq: 1 }]);
    expect(cloud.count()).toBe(1);
  });

  it("cannot forge machine_id: the stamp comes from the token", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);

    // The row claims to be from the work Mac. The token says otherwise.
    await client.postIntervals([interval("a", 0, "forged-by-the-client")]);

    expect(cloud.rows()[0]?.machine_id).toBe(MACHINE_A);
  });

  it("reports a row present on the second post too — a duplicate is a no-op", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);
    const row = interval("a", 0);

    const first = await client.postIntervals([row]);
    const second = await client.postIntervals([row]);

    expect(first.present).toEqual(second.present);
    expect(cloud.count()).toBe(1);
  });

  it("throws HttpError with the status on a non-2xx, and never a result", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud, "wrong-token");

    await expect(client.postIntervals([interval("a", 0)])).rejects.toBeInstanceOf(HttpError);
    await expect(client.postIntervals([interval("a", 0)])).rejects.toMatchObject({
      status: 401,
    });
    expect(cloud.count()).toBe(0);
  });

  it("lets a failed fetch reject — there is no reachability probe to consult", async () => {
    const cloud = new FakeCloud();
    cloud.offline = true;

    await expect(clientFor(cloud).postIntervals([interval("a", 0)])).rejects.toThrow(
      /fetch failed/,
    );
  });

  it("refuses more rows than the Worker's cap, naming the caller not the server", async () => {
    const cloud = new FakeCloud();
    const rows = Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) =>
      interval(`r-${String(i)}`, 0),
    );

    await expect(clientFor(cloud).postIntervals(rows)).rejects.toBeInstanceOf(RangeError);
    expect(cloud.calls).toHaveLength(0);
  });

  it("maps a pulled row back to the store's shape, seq included", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);
    await client.postIntervals([interval("a", 0)]);

    const page = await client.getIntervals(0);

    expect(page.rows).toHaveLength(1);
    const row = page.rows[0]!;
    expect(row.id).toBe("a");
    expect(row.machineId).toBe(MACHINE_A);
    expect(row.startedAtMs).toBe(t("2026-08-17T09:00:00Z"));
    expect(row.endedAtMs).toBe(t("2026-08-17T09:00:30Z"));
    expect(row.durationS).toBe(30);
    expect(row.keyEvents).toBe(12);
    expect(row.mouseEvents).toBe(3);
    expect(row.cloudSeq).toBe(1);
    // Stamped by the Worker, not by us.
    expect(row.serverMs).toBeGreaterThan(0);
  });

  it("sends every payload column the Worker names, in its order", () => {
    expect(Object.keys(toWireRow(interval("a", 0)))).toEqual([
      "id",
      "machine_id",
      "started_at_ms",
      "ended_at_ms",
      "duration_s",
      "end_reason",
      "tz",
      "local_date",
      "key_events",
      "mouse_events",
      "camera_s",
      "jiggler_s",
      "app_version",
      "schema_v",
      "closed_local_ms",
      "server_ms",
    ]);
  });

  it("clamps since and limit rather than trusting a caller's arithmetic", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);
    await client.postIntervals([interval("a", 0)]);

    await client.getIntervals(-50, 99_999);

    const get = cloud.calls.find((c) => c.method === "GET");
    expect(get?.path).toBe("/intervals");
    // The negative `since` would have been a SQL error rather than a page 1.
    const page = await client.getIntervals(-50, 99_999);
    expect(page.rows).toHaveLength(1);
  });

  it("answers /health without a token — the work Mac's proxy check", async () => {
    const cloud = new FakeCloud();
    const health = await clientFor(cloud, "not-a-token-at-all").health();
    expect(health.ok).toBe(true);
  });

  it("records a heartbeat under the token's machine id", async () => {
    const cloud = new FakeCloud();
    await clientFor(cloud).heartbeat({ label: "personal", appVersion: "0.1.0" });

    expect(
      cloud.d1.query<{ machine_id: string; label: string }>("SELECT * FROM machine"),
    ).toMatchObject([{ machine_id: MACHINE_A, label: "personal" }]);
  });

  it("answers a POST that a garbage collection interrupts", async () => {
    // ── The flake this pins. ────────────────────────────────────────────────
    // undici's `Request.clone()` tees the body, keeps one branch for the
    // ORIGINAL request, and registers that branch in a FinalizationRegistry
    // keyed on the CLONE. Peeking at a body through a throwaway clone and then
    // collecting therefore CANCELS the body the server has not read yet: the
    // Worker sees nothing, answers `400 expected a JSON object`, and a
    // perfectly well-formed upload fails. Collections are frequent on a loaded
    // machine and rare on an idle one, which is exactly how it presented — a
    // couple of failures in twenty runs under load, three different test names,
    // and never once on a quiet laptop.
    const cloud = new FakeCloud();
    cloud.beforeDispatch = collectGarbage;

    const res = await clientFor(cloud).postIntervals([interval("a", 0)]);

    expect(res.present).toEqual([{ id: "a", seq: 1 }]);
    expect(cloud.count()).toBe(1);
    // …and the fake still counted the rows it peeked at.
    expect(cloud.calls.at(-1)?.rows).toBe(1);
  });

  it("returns the cloud fingerprint fields it was promised", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);
    await client.postIntervals([interval("a", 0), interval("b", 1)]);

    const fp = await client.fingerprint();

    expect(fp.count).toBe(2);
    expect(fp.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.maxEndedAtMs).toBe(t("2026-08-17T09:01:30Z"));
  });
});
