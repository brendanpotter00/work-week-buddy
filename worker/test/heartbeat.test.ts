import { describe, it, expect } from "vitest";
import {
  call,
  harness,
  MACHINE_PERSONAL,
  MACHINE_WORK,
  TOKEN_PERSONAL,
  TOKEN_WORK,
} from "./harness.js";
import type { Env } from "../src/types.js";

interface MachineRow {
  machine_id: string;
  label: string | null;
  os_version: string | null;
  app_version: string | null;
  last_seen_ms: number;
}

async function beat(env: Env, token: string, body?: unknown): Promise<Response> {
  return call(env, {
    method: "POST",
    path: "/heartbeat",
    token,
    ...(body === undefined ? {} : { body }),
  });
}

describe("POST /heartbeat", () => {
  it("keys the row on the token's machine, not on anything in the body", async () => {
    const { env, db } = harness();
    const res = await beat(env, TOKEN_WORK, {
      label: "work",
      osVersion: "26.5.1",
      appVersion: "0.1.0",
      machine_id: MACHINE_PERSONAL, // ignored: there is no such bind
      machineId: MACHINE_PERSONAL,
    });
    expect(res.status).toBe(200);
    expect(db.query<MachineRow>("SELECT * FROM machine")).toEqual([
      {
        machine_id: MACHINE_WORK,
        label: "work",
        os_version: "26.5.1",
        app_version: "0.1.0",
        last_seen_ms: expect.any(Number),
      },
    ]);
  });

  it("never moves last_seen_ms backwards, however the beats are ordered", async () => {
    // The upsert is commutative on purpose: two Macs, two clocks, and retries
    // that can arrive in any order. An out-of-order beat must not rewind it.
    const { env, db } = harness();
    await beat(env, TOKEN_PERSONAL, { label: "personal" });
    const first = db.query<MachineRow>("SELECT * FROM machine")[0]!.last_seen_ms;

    // Force an older timestamp in, exactly as a delayed beat would.
    db.raw
      .prepare("UPDATE machine SET last_seen_ms = ? WHERE machine_id = ?")
      .run(first + 60_000, MACHINE_PERSONAL);

    await beat(env, TOKEN_PERSONAL, { label: "personal" });
    const after = db.query<MachineRow>("SELECT * FROM machine")[0]!.last_seen_ms;
    expect(after).toBe(first + 60_000);
  });

  it("keeps one row per machine and updates the descriptive fields", async () => {
    const { env, db } = harness();
    await beat(env, TOKEN_PERSONAL, { label: "old", appVersion: "0.1.0" });
    await beat(env, TOKEN_PERSONAL, { label: "new", appVersion: "0.2.0" });
    await beat(env, TOKEN_WORK, { label: "work" });

    const rows = db.query<MachineRow>("SELECT * FROM machine ORDER BY machine_id");
    expect(rows).toHaveLength(2);
    const personal = rows.find((r) => r.machine_id === MACHINE_PERSONAL)!;
    expect(personal.label).toBe("new");
    expect(personal.app_version).toBe("0.2.0");
  });

  it("tolerates a missing or malformed body and falls back to the machine id as the label", async () => {
    const { env, db } = harness();
    expect((await beat(env, TOKEN_PERSONAL)).status).toBe(200);
    expect(
      (
        await call(env, {
          method: "POST",
          path: "/heartbeat",
          token: TOKEN_WORK,
          rawBody: "not json at all",
        })
      ).status,
    ).toBe(200);

    const rows = db.query<MachineRow>("SELECT * FROM machine ORDER BY machine_id");
    expect(rows.map((r) => r.label).sort()).toEqual(
      [MACHINE_PERSONAL, MACHINE_WORK].sort(),
    );
    expect(rows.every((r) => r.os_version === "")).toBe(true);
  });

  it("ignores non-string descriptive fields rather than failing the bind", async () => {
    const { env, db } = harness();
    const res = await beat(env, TOKEN_PERSONAL, {
      label: 42,
      osVersion: { nested: true },
      appVersion: null,
    });
    expect(res.status).toBe(200);
    const row = db.query<MachineRow>("SELECT * FROM machine")[0]!;
    expect(row.label).toBe(MACHINE_PERSONAL);
    expect(row.os_version).toBe("");
    expect(row.app_version).toBe("");
  });
});
