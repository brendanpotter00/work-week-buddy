/**
 * The bridge is the second of the three layers that keep the renderer away from
 * the database. It catches the one mistake the other two miss: a handler wired
 * up in main without a contract entry.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../../test/fakes/electron"));

import { createBridge } from "./index";
import { INVOKE_CHANNELS, PUSH_CHANNELS } from "../shared/ipc-types";

function harness() {
  const invoked: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, Array<(e: unknown, p: unknown) => void>>();
  const bridge = createBridge({
    invoke: async (channel, payload) => {
      invoked.push({ channel, payload });
      return "ok";
    },
    on: (channel, listener) => {
      const l = listeners.get(channel) ?? [];
      l.push(listener);
      listeners.set(channel, l);
    },
    removeListener: (channel, listener) => {
      const l = listeners.get(channel) ?? [];
      const i = l.indexOf(listener);
      if (i >= 0) l.splice(i, 1);
    },
  });
  return { bridge, invoked, listeners };
}

describe("the preload allowlist", () => {
  it("M13: rejects a channel that is not in the contract", async () => {
    const { bridge, invoked } = harness();
    await expect(
      (bridge.invoke as (c: string, p: unknown) => Promise<unknown>)("wwb:evil", null),
    ).rejects.toThrow(/blocked invoke channel/);
    expect(invoked).toHaveLength(0);
  });

  it("lets every contract channel through", async () => {
    const { bridge, invoked } = harness();
    for (const channel of INVOKE_CHANNELS) {
      await (bridge.invoke as (c: string, p: unknown) => Promise<unknown>)(channel, undefined);
    }
    expect(invoked.map((i) => i.channel)).toEqual([...INVOKE_CHANNELS]);
  });

  it("rejects a push channel that is not in the contract", () => {
    const { bridge } = harness();
    expect(() =>
      (bridge.on as (c: string, cb: () => void) => void)("wwb:push:evil", () => {}),
    ).toThrow(/blocked push channel/);
  });

  it("strips the IpcRendererEvent — `sender` is a capability, not a payload", () => {
    const { bridge, listeners } = harness();
    const seen: unknown[] = [];
    bridge.on("wwb:push:metrics-stale", (p) => seen.push(p));
    const event = { sender: "a capability we do not hand to page code" };
    listeners.get("wwb:push:metrics-stale")![0]!(event, { reason: "interval-close" });
    expect(seen).toEqual([{ reason: "interval-close" }]);
  });

  it("is built as CommonJS, or none of the above ever runs", async () => {
    // `package.json` carries "type": "module", so without this pin electron-vite
    // emits `out/preload/index.mjs` — and an ESM preload under `sandbox: true`
    // fails to load with no renderer error at all: `window.wwb` is simply
    // `undefined`. Asserting the build config is the only place this trap can
    // be caught before a human opens the app and sees a blank dashboard.
    const config = (await import("../../electron.vite.config")).default as {
      preload: { build: { rollupOptions: { output: { format: string; entryFileNames: string } } } };
    };
    expect(config.preload.build.rollupOptions.output.format).toBe("cjs");
    expect(config.preload.build.rollupOptions.output.entryFileNames).toBe("index.js");
  });

  it("unsubscribes, so a remounting component does not leak listeners", () => {
    const { bridge, listeners } = harness();
    for (const channel of PUSH_CHANNELS) {
      const offs = Array.from({ length: 50 }, () => bridge.on(channel, () => {}));
      expect(listeners.get(channel)).toHaveLength(50);
      for (const off of offs) off();
      expect(listeners.get(channel)).toHaveLength(0);
    }
  });
});
