// @vitest-environment jsdom
/**
 * "Sync now" in the dashboard's status strip.
 *
 * The failure this file exists to prevent: a button that looks identical
 * whether it uploaded twelve rows or failed with an auth error. Every test
 * below is an outcome that has to be TELLABLE APART from the others without
 * opening a second window.
 *
 * The plumbing is the settings pane's — `useFlush()`, one implementation — so
 * what is asserted here is the reporting and the guards, not the IPC call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import type { FlushResult, SyncConfigState } from "@/shared/ipc-types";
import {
  cardByLabel,
  cardValue,
  defaultHandlers,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  renderApp,
  syncConfigState,
} from "./harness";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

const CONFIGURED: Partial<SyncConfigState> = {
  workerUrl: "https://wwb-sync.example.workers.dev",
  tokenPresent: true,
  configured: true,
};

function flushResult(over: Partial<FlushResult> = {}): FlushResult {
  return {
    ok: true,
    attempted: 12,
    confirmed: 12,
    pendingAfter: 0,
    error: null,
    atMs: Date.parse("2026-08-19T14:41:00-05:00"),
    ...over,
  };
}

interface Mounted {
  bridge: ReturnType<typeof makeBridge>;
  container: HTMLElement;
}

async function mount(over: {
  config?: Partial<SyncConfigState>;
  flush?: () => FlushResult | Promise<FlushResult>;
}): Promise<Mounted> {
  const bridge = makeBridge({
    ...defaultHandlers(metricsBundle()),
    "wwb:sync:config": () => syncConfigState(over.config ?? {}),
    ...(over.flush ? { "wwb:sync:flush": over.flush } : {}),
  });
  installBridge(bridge);
  const { container } = renderApp(<App />);
  await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));
  return { bridge, container };
}

const button = (c: HTMLElement): HTMLButtonElement => {
  const el = c.querySelector<HTMLButtonElement>('[data-slot="sync-now-button"]');
  if (!el) throw new Error("no Sync now button in the status strip");
  return el;
};

const result = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[data-slot="sync-now-result"]');

const blocked = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[data-slot="sync-now-blocked"]');

describe("where the button is", () => {
  it("sits in the status strip, beside the jiggler and keep-awake switches", async () => {
    // The owner's words: "can you add a sync now button to the top of the
    // dashboard where the jiggler and keep awake are".
    const { container } = await mount({ config: CONFIGURED });
    const strip = container.querySelector('[data-slot="status-strip"]');
    expect(strip?.querySelector('[data-slot="sync-now"]')).not.toBeNull();
    expect(strip?.textContent).toContain("Jiggler");
    expect(strip?.textContent).toContain("Keep awake");
  });
});

describe("what it says when it worked", () => {
  it("names the number of rows it actually sent", async () => {
    // `confirmed`, not `attempted`: AGENTS.md #8 — a row counts as synced on
    // its PRESENCE in the response, never on the insert having been sent.
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult({ attempted: 12, confirmed: 12 }),
    });
    act(() => button(container).click());

    await waitFor(() => expect(result(container)?.textContent).toBe("Sent 12 rows"));
    expect(result(container)?.getAttribute("data-ok")).toBe("true");
    expect(result(container)?.getAttribute("role")).toBe("status");
    expect(result(container)?.className).not.toContain("text-destructive");
  });

  it("says one row, not '1 rows'", async () => {
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult({ attempted: 1, confirmed: 1 }),
    });
    act(() => button(container).click());
    await waitFor(() => expect(result(container)?.textContent).toBe("Sent 1 row"));
  });

  it("does not claim to have sent anything when there was nothing waiting", async () => {
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult({ attempted: 0, confirmed: 0 }),
    });
    act(() => button(container).click());
    await waitFor(() => expect(result(container)?.textContent).toBe("Nothing to send"));
  });

  it("does not read as finished when rows are STILL waiting", async () => {
    // ok:true with a queue that did not empty is the silent-SUCCESS half of the
    // same mistake as a silent failure: a batch limit, a partial response, and
    // a green tick over rows that are still here.
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult({ attempted: 500, confirmed: 500, pendingAfter: 240 }),
    });
    act(() => button(container).click());

    await waitFor(() => expect(result(container)?.textContent).toBe("Sent 500 rows, 240 left"));
    expect(result(container)?.getAttribute("title")).toContain("240 rows still waiting");
  });
});

describe("what it says when it did not", () => {
  it("prints the reason, in red, as an alert", async () => {
    const { container } = await mount({
      config: CONFIGURED,
      flush: () =>
        flushResult({ ok: false, confirmed: 0, pendingAfter: 12, error: "401 unauthorized" }),
    });
    act(() => button(container).click());

    await waitFor(() =>
      expect(result(container)?.textContent).toBe("Sync failed — 401 unauthorized"),
    );
    const el = result(container)!;
    expect(el.getAttribute("data-ok")).toBe("false");
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.className).toContain("text-destructive");
    // Nothing is lost on a failed flush — the local mirror IS the outbox.
    expect(el.getAttribute("title")).toContain("nothing has been lost");
  });

  it("never fails silently, even when the failure came with no reason", async () => {
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult({ ok: false, confirmed: 0, error: null }),
    });
    act(() => button(container).click());
    await waitFor(() =>
      expect(result(container)?.textContent).toBe("Sync failed — no reason given"),
    );
  });

  it("reports a rejected IPC call as a failure and not as a hung button", async () => {
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => {
        throw new Error("the main process is not answering");
      },
    });
    act(() => button(container).click());

    await waitFor(() =>
      expect(result(container)?.textContent).toBe(
        "Sync failed — the main process is not answering",
      ),
    );
    // …and it is clickable again, rather than stuck on "Syncing…".
    expect(button(container).disabled).toBe(false);
    expect(button(container).textContent).toBe("Sync now");
  });
});

describe("a Mac that never set cloud sync up", () => {
  it("is disabled with a reason rather than failing on click", async () => {
    // This is the state a real install is in. A live-looking button that
    // answers with an error teaches the owner that the button lies.
    const { container, bridge } = await mount({});
    expect(button(container).disabled).toBe(true);
    expect(blocked(container)?.textContent).toBe("not set up");
    expect(button(container).getAttribute("title")).toContain("Cloud sync is not set up");
    expect(result(container)).toBeNull();

    act(() => button(container).click());
    expect(bridge.calls.filter((c) => c.channel === "wwb:sync:flush")).toHaveLength(0);
  });

  it("says which half is missing when only one is", async () => {
    const { container } = await mount({
      config: { workerUrl: "https://x.workers.dev", tokenPresent: false },
    });
    expect(button(container).disabled).toBe(true);
    expect(button(container).getAttribute("title")).toContain("token is not");
  });

  it("does not claim anything before the config snapshot has landed", async () => {
    // "not set up" and "we have not looked yet" are different claims, and only
    // one of them is true in the first frame.
    const bridge = makeBridge({
      ...defaultHandlers(metricsBundle()),
      "wwb:sync:config": () => new Promise<SyncConfigState>(() => undefined),
    });
    installBridge(bridge);
    const { container } = renderApp(<App />);
    await waitFor(() => expect(cardValue(cardByLabel(container, "This week"))).toBe("36.5"));

    expect(button(container).disabled).toBe(true);
    expect(blocked(container)?.textContent).toBe("checking…");
    expect(button(container).getAttribute("title")).toContain("Checking whether");
  });

  it("comes alive when main pushes a finished setup, with no reload", async () => {
    const { container, bridge } = await mount({});
    expect(button(container).disabled).toBe(true);

    act(() => bridge.emit("wwb:push:sync-config", syncConfigState(CONFIGURED)));

    await waitFor(() => expect(button(container).disabled).toBe(false));
    expect(blocked(container)).toBeNull();
  });
});

describe("one flush at a time", () => {
  it("cannot start a second while one is running", async () => {
    let release: ((r: FlushResult) => void) | null = null;
    const { container, bridge } = await mount({
      config: CONFIGURED,
      flush: () =>
        new Promise<FlushResult>((res) => {
          release = res;
        }),
    });

    act(() => button(container).click());
    await waitFor(() => expect(button(container).textContent).toBe("Syncing…"));
    expect(button(container).disabled).toBe(true);

    // Clicking the disabled button, and calling the handler directly — because
    // `disabled` is a render away from being true and the real double-click
    // lands inside that frame. The ref guard is what has to hold.
    act(() => button(container).click());
    act(() => button(container).click());
    expect(bridge.calls.filter((c) => c.channel === "wwb:sync:flush")).toHaveLength(1);

    await act(async () => {
      release?.(flushResult({ attempted: 3, confirmed: 3 }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result(container)?.textContent).toBe("Sent 3 rows"));
    // …and one flush later it is available again.
    expect(button(container).disabled).toBe(false);
    act(() => button(container).click());
    expect(bridge.calls.filter((c) => c.channel === "wwb:sync:flush")).toHaveLength(2);
  });

  it("does not put a dialog on the click path", async () => {
    // Nothing on a path the owner is waiting on may open a modal — the same
    // rule the settings pane's 'use the other address' button states.
    const { container } = await mount({
      config: CONFIGURED,
      flush: () => flushResult(),
    });
    act(() => button(container).click());
    await waitFor(() => expect(result(container)).not.toBeNull());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("the strip still fits", () => {
  it("truncates the outcome instead of widening the row", async () => {
    // The dashboard's minimum width is 880px and the page body may never
    // scroll sideways — `npm run smoke` fails on that. jsdom cannot measure,
    // so the CLASSES that make it impossible are what is pinned.
    const { container } = await mount({
      config: CONFIGURED,
      flush: () =>
        flushResult({
          ok: false,
          error: "a very long explanation of exactly what went wrong ".repeat(6),
        }),
    });
    act(() => button(container).click());
    await waitFor(() => expect(result(container)).not.toBeNull());

    expect(result(container)?.className).toContain("truncate");
    expect(result(container)?.className).toContain("min-w-0");
    // …and the whole sentence is still reachable.
    expect(result(container)?.getAttribute("title")).toContain("went wrong");

    const strip = container.querySelector('[data-slot="status-strip"]')!;
    // The two switches never give ground; the sync note is the elastic cell.
    for (const label of strip.querySelectorAll("label")) {
      expect(label.className).toContain("shrink-0");
    }
  });
});
