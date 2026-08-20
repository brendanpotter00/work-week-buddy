/**
 * Backup layer 3.
 *
 * The client hashes with `node:crypto` and the Worker with `crypto.subtle`, so
 * the first test here is worth more than it looks: two independent
 * implementations agree only if both followed the one written definition. A
 * disagreement about the joining character would show up as a permanent
 * mismatch alarm that is indistinguishable from real data loss.
 */
import { describe, it, expect } from "vitest";
import { createWorkerClient } from "../../src/sync/client";
import {
  fingerprintSha256,
  localFingerprint,
  reconcile,
  type ReconcileReport,
} from "../../src/sync/fingerprint";
import { pull } from "../../src/sync/pull";
import { fingerprintSha256 as workerSha256 } from "../../worker/src/fingerprint.js";
import { insertClosed } from "../../src/store/intervals";
import { makeRow, openTestDb } from "../fakes/seed-db";
import { BASE_URL, FakeCloud, TOKEN_PERSONAL } from "./fake-cloud";
import { testFlusher } from "./flusher";

/** The digest of the empty string. An empty table is a real value, not a case. */
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function rows(db: ReturnType<typeof openTestDb>, ids: readonly string[]): void {
  ids.forEach((id, i) => {
    insertClosed(
      db,
      makeRow({
        id,
        machineId: "personal",
        start: `2026-08-17T09:${String(i).padStart(2, "0")}:00Z`,
        end: `2026-08-17T09:${String(i).padStart(2, "0")}:30Z`,
      }),
    );
  });
}

function clientFor(cloud: FakeCloud) {
  return createWorkerClient({
    baseUrl: BASE_URL,
    token: TOKEN_PERSONAL,
    fetchImpl: cloud.fetch,
  });
}

describe("the fingerprint hash", () => {
  it("agrees with the Worker's, byte for byte, over the same ids", async () => {
    const ids = ["b", "a", "c-with-dash", "0191f0a0-7000-7000-8000-000000000001"];
    expect(fingerprintSha256(ids)).toBe(await workerSha256(ids));
  });

  it("hashes the empty set to the digest of the empty string", async () => {
    expect(fingerprintSha256([])).toBe(EMPTY_SHA);
    expect(await workerSha256([])).toBe(EMPTY_SHA);
  });

  it("does not depend on the order the ids arrived in", () => {
    expect(fingerprintSha256(["a", "b", "c"])).toBe(fingerprintSha256(["c", "a", "b"]));
  });

  it("changes when a single id is missing", () => {
    expect(fingerprintSha256(["a", "b", "c"])).not.toBe(fingerprintSha256(["a", "c"]));
  });
});

describe("the local fingerprint", () => {
  it("covers the rows we believe the cloud has, and no others", () => {
    const db = openTestDb();
    rows(db, ["a", "b", "c"]);
    db.exec("UPDATE work_interval SET synced_at_ms = 1 WHERE id IN ('a','b')");

    const fp = localFingerprint(db);

    expect(fp.count).toBe(2);
    expect(fp.pending).toBe(1);
    expect(fp.sha256).toBe(fingerprintSha256(["a", "b"]));
    // An outbox is not a mismatch, and an alarm that cries wolf during a normal
    // offline hour is an alarm that gets ignored the month it matters.
    expect(fp.sha256).not.toBe(fingerprintSha256(["a", "b", "c"]));
  });

  it("is the empty digest for a fresh mirror", () => {
    expect(localFingerprint(openTestDb())).toMatchObject({
      count: 0,
      pending: 0,
      sha256: EMPTY_SHA,
      maxEndedAtMs: 0,
    });
  });
});

describe("reconcile", () => {
  it("matches once a flush has landed everything", async () => {
    const cloud = new FakeCloud();
    const db = openTestDb();
    const client = clientFor(cloud);
    rows(db, ["a", "b", "c"]);
    await testFlusher({ db, client }).flush();

    const report = await reconcile(db, client);

    expect(report.status).toBe("match");
    expect(report.local.sha256).toBe(report.remote.sha256);
    expect(report.local.count).toBe(3);
    expect(report.missingFromCloud).toBe(0);
  });

  it("matches across both machines once each has pulled the other", async () => {
    const cloud = new FakeCloud();
    const client = clientFor(cloud);
    const db = openTestDb();
    rows(db, ["a", "b"]);
    await testFlusher({ db, client }).flush();

    // The other Mac's rows arrive by pull; the local synced set must converge
    // on the cloud set or the weekly check means nothing.
    const otherCloudRows = openTestDb();
    rows(otherCloudRows, ["x", "y"]);
    const otherClient = createWorkerClient({
      baseUrl: BASE_URL,
      token: TOKEN_PERSONAL,
      fetchImpl: cloud.fetch,
    });
    await testFlusher({ db: otherCloudRows, client: otherClient }).flush();

    await pull(db, client);

    const report = await reconcile(db, client);
    expect(report.status).toBe("match");
    expect(report.local.count).toBe(4);
  });

  it("reports a mismatch — loudly — when the cloud has silently lost a row", async () => {
    const cloud = new FakeCloud();
    const db = openTestDb();
    const client = clientFor(cloud);
    rows(db, ["a", "b", "c"]);
    await testFlusher({ db, client }).flush();

    // Silent loss: no error, no exception, nothing in any log. This check is
    // the only thing in the product that would ever notice.
    cloud.d1.raw.exec("DELETE FROM work_interval WHERE id = 'b'");

    const seen: ReconcileReport[] = [];
    const report = await reconcile(db, client, { onMismatch: (r) => seen.push(r) });

    expect(report.status).toBe("mismatch");
    expect(report.missingFromCloud).toBe(1);
    expect(report.local.pending).toBe(0); // so it is loss, not an outbox
    expect(seen).toHaveLength(1);
  });

  it("does not repair anything by itself", async () => {
    const cloud = new FakeCloud();
    const db = openTestDb();
    const client = clientFor(cloud);
    rows(db, ["a", "b"]);
    await testFlusher({ db, client }).flush();
    cloud.wipe();

    await reconcile(db, client);

    // Re-uploading a database it has just decided it does not understand is a
    // decision for a human, after reading the report. Marking the rows unsynced
    // and flushing is that repair, and it is one line.
    expect(cloud.count()).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM work_interval WHERE synced_at_ms IS NULL").get(),
    ).toMatchObject({ c: 0 });
  });

  it("stamps the check time from the injected clock", async () => {
    const cloud = new FakeCloud();
    const db = openTestDb();
    const report = await reconcile(db, clientFor(cloud), { nowMs: () => 777 });
    expect(report.checkedAtMs).toBe(777);
  });
});
