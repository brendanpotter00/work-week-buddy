/**
 * The one piece of logic in `net.ts`: the not-ready guard.
 *
 * Everything else about `net.fetch` is Chromium's and cannot be usefully
 * faked — the behaviour that actually mattered (does `AbortSignal.timeout`
 * still abort?) was measured against a real Electron process before this was
 * wired in, and the numbers are in `net.ts`'s header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../../test/fakes/electron"));

import { app, net } from "../../test/fakes/electron";
import { appFetch } from "./net";

beforeEach(() => {
  app.ready = true;
  net.calls.length = 0;
  net.nextStatus = 200;
});

describe("the app's outbound fetch", () => {
  it("goes through Chromium's stack, not Node's", async () => {
    const res = await appFetch("https://example.test/health");
    expect(res.status).toBe(200);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.input).toBe("https://example.test/health");
  });

  it("passes the init through untouched — the timeout signal above all", async () => {
    const signal = AbortSignal.timeout(30_000);
    const headers = new Headers({ authorization: "Bearer x" });
    await appFetch("https://example.test/machines", { method: "GET", headers, signal });
    const init = net.calls[0]?.init as RequestInit | undefined;
    // `src/cloud/api.ts` and `src/sync/client.ts` both depend on this signal
    // reaching the network layer. A wrapper that dropped it would leave the
    // flusher's single-flight guard closed for ever on one hung socket.
    expect(init?.signal).toBe(signal);
    expect(init?.headers).toBe(headers);
  });

  it("accepts a URL, which net.fetch itself does not", async () => {
    await appFetch(new URL("https://example.test/health"));
    expect(net.calls[0]?.input).toBe("https://example.test/health");
  });

  it("refuses before the app is ready, and says why", async () => {
    // Chromium's network stack does not exist yet at that point. Electron's own
    // error names none of this, and a reachability check that died that way
    // would read exactly like the network failure it was trying to diagnose.
    app.ready = false;
    await expect(appFetch("https://example.test/health")).rejects.toThrow(
      /before the app was ready/,
    );
    expect(net.calls).toEqual([]);
  });
});
