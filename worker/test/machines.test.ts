/**
 * `GET /machines` — the read half of the heartbeat.
 *
 * `work_interval` carries `machine_id` and never a label, so a row pulled from
 * the other Mac is anonymous until the machine row that names it arrives. This
 * route is how it arrives. Without it, one Mac renders the other as a raw
 * IOPlatformUUID forever, silently and with nothing to notice.
 */
import { describe, it, expect } from "vitest";
import {
  call,
  harness,
  json,
  MACHINE_A,
  MACHINE_B,
  TOKEN_A,
  TOKEN_B,
} from "./harness.js";

interface WireMachine {
  machine_id: string;
  label: string | null;
  os_version: string | null;
  app_version: string | null;
  last_seen_ms: number;
}

describe("GET /machines", () => {
  it("returns every machine, so either Mac can name the other", async () => {
    const { env } = harness();
    await call(env, {
      method: "POST",
      path: "/heartbeat",
      token: TOKEN_A,
      body: { label: "The loft mini", osVersion: "26.5.1", appVersion: "0.1.0" },
    });
    await call(env, {
      method: "POST",
      path: "/heartbeat",
      token: TOKEN_B,
      body: { label: "Work laptop", osVersion: "26.5.1", appVersion: "0.1.0" },
    });

    // Read with the PERSONAL token, and the WORK machine's name comes back.
    // That is the entire point: a token names one machine, but the labels are
    // shared, because a breakdown that can only name the Mac you are sitting at
    // is not a breakdown.
    const res = await call(env, { method: "GET", path: "/machines", token: TOKEN_A });
    expect(res.status).toBe(200);

    const body = await json<{ machines: WireMachine[] }>(res);
    expect(body.machines.map((m) => [m.machine_id, m.label])).toEqual(
      [
        [MACHINE_A, "The loft mini"],
        [MACHINE_B, "Work laptop"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(body.machines.every((m) => typeof m.last_seen_ms === "number")).toBe(true);
  });

  it("answers an empty list before any Mac has ever beaten", async () => {
    const { env } = harness();
    const res = await call(env, { method: "GET", path: "/machines", token: TOKEN_B });
    expect(res.status).toBe(200);
    // Not a 404. A fresh deploy has no machines and that is a state, not a
    // failure — the client would otherwise report a broken pull on day one.
    expect(await json<{ machines: WireMachine[] }>(res)).toEqual({ machines: [] });
  });

  it("needs a token, like every route that is not /health", async () => {
    const { env } = harness();
    expect((await call(env, { method: "GET", path: "/machines" })).status).toBe(401);
    expect(
      (await call(env, { method: "GET", path: "/machines", token: "wrong" })).status,
    ).toBe(401);
  });

  it("reflects a rename on the next read", async () => {
    const { env } = harness();
    const beat = (label: string): Promise<Response> =>
      call(env, { method: "POST", path: "/heartbeat", token: TOKEN_B, body: { label } });

    await beat("MacBook Pro");
    await beat("The loft mini");

    const body = await json<{ machines: WireMachine[] }>(
      await call(env, { method: "GET", path: "/machines", token: TOKEN_A }),
    );
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0]?.label).toBe("The loft mini");
  });
});
