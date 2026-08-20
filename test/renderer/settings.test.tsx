// @vitest-environment jsdom
/**
 * The settings window, against a stubbed bridge.
 *
 * The claim this file exists to prove is not "the form renders". It is:
 *
 *  1. Typing a URL and a token reaches `wwb:sync:setConfig` with the right
 *     payload, and the pane flips to configured. Sync was dead because nothing
 *     in the renderer ever called that channel; a test that only rendered the
 *     inputs would have passed the whole time it was dead.
 *  2. THE TOKEN NEVER LEAVES. Not into the DOM, not into an attribute, not into
 *     what the pane renders back, not into any other IPC payload.
 *  3. A URL that cannot work is rejected BEFORE the write, because saving a
 *     wrong one is silent — the flusher retries in the background and the only
 *     symptom is the other Mac's hours never appearing.
 *  4. The three sync states render as three different things.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { Settings } from "@/renderer/Settings";
import type {
  InvokeChannel,
  SyncConfigState,
  SyncTestResult,
  UiSettings,
} from "@/shared/ipc-types";
import {
  appInfo,
  doctorReport,
  installBridge,
  installDomStubs,
  makeBridge,
  selfTestResult,
  syncConfigState,
  uiSettings,
  renderApp,
  type StubBridge,
} from "./harness";

/** A token shaped like a real one, so a substring search cannot pass by luck. */
const TOKEN = "wwb_9f3c1d7a54e84b0da2c6f18e7b3a09d5";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

interface Fixture {
  bridge: StubBridge;
  /** Every `setConfig` payload, in order. The token is only ever HERE. */
  writes: Array<{ workerUrl?: string; token?: string }>;
  tests: Array<{ workerUrl?: string; token?: string }>;
  settingsWrites: Array<Partial<UiSettings>>;
  state: () => SyncConfigState;
}

function mount(
  over: {
    config?: Partial<SyncConfigState>;
    doctor?: Parameters<typeof doctorReport>[0];
    settings?: Partial<UiSettings>;
    testResult?: SyncTestResult;
  } = {},
): Fixture {
  const writes: Fixture["writes"] = [];
  const tests: Fixture["tests"] = [];
  const settingsWrites: Fixture["settingsWrites"] = [];
  let config = syncConfigState(over.config);
  let stored = uiSettings(over.settings);

  const bridge = makeBridge({
    "wwb:app:info": () => appInfo(),
    "wwb:settings:get": () => stored,
    "wwb:settings:set": (patch) => {
      settingsWrites.push(patch);
      stored = { ...stored, ...patch };
      return stored;
    },
    "wwb:doctor:get": () => doctorReport(over.doctor),
    "wwb:doctor:selftest": () => selfTestResult(),
    "wwb:sync:config": () => config,
    // Main's behaviour: the URL is stored, the token goes to the vault, and
    // what comes back is a state object with no field a token could ride on.
    "wwb:sync:setConfig": (patch) => {
      writes.push(patch);
      config = syncConfigState({
        workerUrl: patch.workerUrl ?? config.workerUrl,
        tokenPresent: patch.token !== undefined ? true : config.tokenPresent,
        error: null,
      });
      config = { ...config, configured: config.workerUrl !== "" && config.tokenPresent };
      return config;
    },
    "wwb:sync:test": (patch) => {
      tests.push(patch);
      return (
        over.testResult ?? {
          ok: true,
          reachable: true,
          authorized: true,
          status: 200,
          ms: 41,
          error: null,
        }
      );
    },
    "wwb:sync:flush": () => ({
      ok: true,
      attempted: 2,
      confirmed: 2,
      pendingAfter: 0,
      error: null,
      atMs: Date.now(),
    }),
    "wwb:machine:rename": ({ label }) => appInfo({ machineLabel: label.trim() }),
    "wwb:window:openDashboard": () => undefined,
  });
  installBridge(bridge);
  renderApp(<Settings />);
  return { bridge, writes, tests, settingsWrites, state: () => config };
}

/**
 * SCOPED, always. This window has several cards and more than one of them has a
 * "Save" — the sync form's and the rename field's. A global `getByRole` would
 * either be ambiguous or, worse, silently pick the wrong one.
 */
function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section="${id}"]`);
  if (el === null) throw new Error(`no settings card "${id}"`);
  return el;
}

function list(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-list="${id}"]`);
  if (el === null) throw new Error(`no bundle list "${id}"`);
  return el;
}

const urlField = (): HTMLInputElement =>
  within(card("sync")).getByLabelText("Worker URL") as HTMLInputElement;
const tokenField = (): HTMLInputElement =>
  within(card("sync")).getByLabelText("This Mac’s token") as HTMLInputElement;
const button = (scope: HTMLElement, name: RegExp): HTMLButtonElement =>
  within(scope).getByRole("button", { name }) as HTMLButtonElement;
const syncButton = (name: RegExp): HTMLButtonElement => button(card("sync"), name);

function type(el: HTMLInputElement, value: string): void {
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
}

/** Every string anywhere in the rendered tree, attributes included. */
function domHaystack(): string {
  const root = document.body;
  const parts: string[] = [root.innerHTML, root.textContent ?? ""];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) parts.push(attr.value);
    // The one place a controlled input WOULD have put it. Asserted explicitly
    // so "React happened not to write the attribute" is not what passes this.
    if (el instanceof HTMLInputElement) parts.push(el.defaultValue);
  }
  return parts.join("\n");
}

describe("turning sync on", () => {
  it("sends the URL and the token to wwb:sync:setConfig and flips to configured", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "https://wwb-sync.example.workers.dev");
    type(tokenField(), TOKEN);
    act(() => syncButton(/^Save$/).click());

    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toEqual({
      workerUrl: "https://wwb-sync.example.workers.dev",
      token: TOKEN,
    });
    // The state main reports, not a local guess.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sync-status"]')?.textContent).toBe("Syncing"),
    );
    expect(f.state().configured).toBe(true);
  });

  it("accepts a token pasted with whitespace — a terminal copy has a newline on it", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "  https://wwb-sync.example.workers.dev\n");
    type(tokenField(), `  ${TOKEN}\n`);
    act(() => syncButton(/^Save$/).click());

    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toEqual({
      workerUrl: "https://wwb-sync.example.workers.dev",
      token: TOKEN,
    });
  });

  it("sends only the half that was edited, so re-saving a URL cannot clear a token", async () => {
    const f = mount({
      config: {
        workerUrl: "https://old.workers.dev",
        tokenPresent: true,
        configured: true,
      },
    });
    await screen.findByText("Cloud sync");

    type(urlField(), "https://new.workers.dev");
    act(() => syncButton(/^Save$/).click());

    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toEqual({ workerUrl: "https://new.workers.dev" });
    expect(f.writes[0]).not.toHaveProperty("token");
  });
});

describe("the token never leaves", () => {
  it("is absent from the DOM, from every attribute, and from what the pane renders back", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "https://wwb-sync.example.workers.dev");
    type(tokenField(), TOKEN);

    // Typed but not yet saved: it is in the input element's `.value` property
    // and NOWHERE else. That property is not serialised by innerHTML and is not
    // an attribute, which is the whole reason the field is uncontrolled.
    expect(domHaystack()).not.toContain(TOKEN);
    expect(tokenField().value).toBe(TOKEN);
    expect(tokenField().type).toBe("password");

    act(() => syncButton(/^Save$/).click());
    await waitFor(() => expect(f.writes).toHaveLength(1));

    // Written, and the field is blanked immediately afterwards.
    await waitFor(() => expect(tokenField().value).toBe(""));
    expect(domHaystack()).not.toContain(TOKEN);
    // Reading the config back cannot produce it either: `SyncConfigState` has
    // no field to carry one.
    expect(JSON.stringify(f.state())).not.toContain(TOKEN);
  });

  it("rides on exactly one channel and never on another", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "https://wwb-sync.example.workers.dev");
    type(tokenField(), TOKEN);
    act(() => syncButton(/Test connection/).click());
    await waitFor(() => expect(f.tests).toHaveLength(1));
    act(() => syncButton(/^Save$/).click());
    await waitFor(() => expect(f.writes).toHaveLength(1));

    // `JSON.stringify(undefined)` is `undefined`, and several channels take a
    // void payload — hence the `?? ""` rather than a bare `.includes`.
    const carrying = f.bridge.calls.filter((c) =>
      (JSON.stringify(c.payload) ?? "").includes(TOKEN),
    );
    expect(new Set(carrying.map((c) => c.channel))).toEqual(
      new Set<InvokeChannel>(["wwb:sync:test", "wwb:sync:setConfig"]),
    );
    // In particular NOT the ordinary settings channel, which writes plaintext
    // JSON to disk.
    expect(JSON.stringify(f.settingsWrites)).not.toContain(TOKEN);
  });
});

describe("a URL that cannot work is rejected before it is saved", () => {
  it("does not write, and says why beside the field", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "wwb-sync.example.workers.dev");

    await waitFor(() => expect(urlField().getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByRole("alert").textContent).toMatch(/not a URL/);
    expect(syncButton(/^Save$/).disabled).toBe(true);

    act(() => syncButton(/^Save$/).click());
    expect(f.writes).toHaveLength(0);
    // …and the test button will not spend a round trip on it either.
    expect(syncButton(/Test connection/).disabled).toBe(true);
  });

  it("recovers the moment it becomes a URL", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    type(urlField(), "nope");
    await waitFor(() => expect(syncButton(/^Save$/).disabled).toBe(true));
    type(urlField(), "https://wwb-sync.example.workers.dev");
    await waitFor(() => expect(syncButton(/^Save$/).disabled).toBe(false));

    act(() => syncButton(/^Save$/).click());
    await waitFor(() => expect(f.writes).toHaveLength(1));
  });
});

describe("test connection", () => {
  it("asks main and reports that the token was accepted", async () => {
    const f = mount({ config: { workerUrl: "https://x.workers.dev", tokenPresent: true, configured: true } });
    await screen.findByText("Cloud sync");

    act(() => syncButton(/Test connection/).click());
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sync-test-result"]')?.textContent).toMatch(
        /token was accepted/,
      ),
    );
    // Nothing was stored: the point of the button is that a wrong answer costs
    // nothing.
    expect(f.writes).toHaveLength(0);
    expect(f.tests).toHaveLength(1);
  });

  it("keeps 'reachable but rejected the token' distinct from 'could not reach it'", async () => {
    mount({
      config: { workerUrl: "https://x.workers.dev", tokenPresent: true, configured: true },
      testResult: {
        ok: false,
        reachable: true,
        authorized: false,
        status: 401,
        ms: 30,
        error: "the Worker is reachable but rejected this token",
      },
    });
    await screen.findByText("Cloud sync");

    act(() => syncButton(/Test connection/).click());
    const line = await waitFor(() => {
      const el = document.querySelector('[data-slot="sync-test-result"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(line.getAttribute("data-ok")).toBe("false");
    expect(line.textContent).toMatch(/rejected this token/);
  });
});

describe("the three sync states each render as their own thing", () => {
  it("not configured is neither green nor red, and promises the hours are safe", async () => {
    mount();
    await screen.findByText("Cloud sync");
    const badge = document.querySelector('[data-slot="sync-status"]')!;
    expect(badge.getAttribute("data-tone")).toBe("unconfigured");
    expect(badge.textContent).toBe("Not set up");
    expect(document.querySelector('[data-slot="sync-note"]')?.textContent).toMatch(
      /kept on this Mac/i,
    );
    // No error banner. An owner with no D1 database is not in trouble.
    expect(screen.queryByText("Sync is not getting through")).toBeNull();
    // The numbers are still shown, so this screen does not look like a
    // different one from the working case.
    expect(document.querySelector('[data-slot="sync-health"]')).not.toBeNull();
  });

  it("healthy says so and shows the timestamps", async () => {
    const at = Date.parse("2026-08-19T14:30:00-05:00");
    mount({
      config: { workerUrl: "https://x.workers.dev", tokenPresent: true, configured: true },
      doctor: {
        sync: {
          configured: true,
          pendingRows: 0,
          lastFlushOkMs: at,
          lastFlushError: null,
          lastPullMs: at,
          lastPullError: null,
          watermark: 9,
          lastCloudWriteMs: at,
          silentForMs: 1000,
        },
      },
    });
    await screen.findByText("Cloud sync");
    const badge = document.querySelector('[data-slot="sync-status"]')!;
    expect(badge.getAttribute("data-tone")).toBe("healthy");
    expect(badge.textContent).toBe("Syncing");
    expect(screen.queryByText("Sync is not getting through")).toBeNull();
    expect(document.querySelector('[data-slot="sync-health"]')?.textContent).toContain("ago");
  });

  it("failing is loud, names the reason, and is not the same screen as not-configured", async () => {
    mount({
      config: { workerUrl: "https://x.workers.dev", tokenPresent: true, configured: true },
      doctor: {
        sync: {
          configured: true,
          pendingRows: 41,
          lastFlushOkMs: null,
          lastFlushError: "fetch failed: ENOTFOUND",
          lastPullMs: null,
          lastPullError: null,
          watermark: 0,
          lastCloudWriteMs: null,
          silentForMs: null,
        },
      },
    });
    await screen.findByText("Cloud sync");
    const badge = document.querySelector('[data-slot="sync-status"]')!;
    expect(badge.getAttribute("data-tone")).toBe("failing");
    expect(badge.textContent).toBe("Not syncing");
    const alert = await screen.findByText("Sync is not getting through");
    expect(alert.parentElement?.textContent).toMatch(/ENOTFOUND/);
    expect(document.querySelector('[data-slot="sync-health"]')?.textContent).toContain("41");
  });
});

describe("the settings that already existed and had no UI", () => {
  it("renames this Mac through the SAME component the dashboard uses", async () => {
    mount();
    const field = (await screen.findByLabelText("This Mac’s name")) as HTMLInputElement;
    expect(field.value).toBe("Work laptop");

    type(field, "The loft mini");
    act(() => button(card("machine"), /^Save$/i).click());

    await waitFor(() =>
      expect(screen.getByText(/Every hour recorded here now shows this name/)).toBeTruthy(),
    );
  });

  it("writes the idle timeout, clamped to the range the PRD allows", async () => {
    const f = mount();
    const slider = (await screen.findByLabelText(/Idle timeout/)) as HTMLInputElement;
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("15");
    expect(slider.value).toBe("15");

    type(slider, "12");
    await waitFor(() => expect(f.settingsWrites).toContainEqual({ idleTimeoutMin: 12 }));
  });

  it("adds and removes meeting bundle ids, one write per edit", async () => {
    const f = mount();
    const add = (await screen.findByLabelText("Add to Counts as a meeting")) as HTMLInputElement;

    type(add, "com.microsoft.teams2");
    act(() => button(list("meeting-apps"), /^Add$/).click());
    await waitFor(() =>
      expect(f.settingsWrites).toContainEqual({
        meetingApps: ["us.zoom.xos", "com.microsoft.teams2"],
      }),
    );

    act(() => button(list("meeting-apps"), /Remove us\.zoom\.xos/).click());
    await waitFor(() =>
      expect(f.settingsWrites).toContainEqual({ meetingApps: ["com.microsoft.teams2"] }),
    );
  });

  it("refuses a heatmap ramp that is not ascending, rather than applying half of it", async () => {
    const f = mount();
    await screen.findByText("Daily hours colour");
    const light = document.querySelector<HTMLInputElement>("#threshold-0")!;

    type(light, "9"); // 9 · 5 · 8 — out of order
    const apply = button(card("heatmap"), /^Apply$/);
    expect(apply.disabled).toBe(true);
    expect(f.settingsWrites.some((w) => "heatmapThresholdsH" in w)).toBe(false);

    type(light, "3");
    await waitFor(() => expect(button(card("heatmap"), /^Apply$/).disabled).toBe(false));
    act(() => button(card("heatmap"), /^Apply$/).click());
    await waitFor(() =>
      expect(f.settingsWrites).toContainEqual({ heatmapThresholdsH: [3, 5, 8] }),
    );
  });
});

describe("the self-test, which until now only the installer could run", () => {
  it("says NEVER RUN loudly when nothing has ever recorded a result", async () => {
    mount();
    await screen.findByText("Safety check");
    expect(document.querySelector('[data-slot="selftest-status"]')?.textContent).toBe("Never run");
    expect(document.querySelector('[data-slot="selftest-note"]')?.textContent).toMatch(
      /never run the check/i,
    );
  });

  it("shows WHEN it last passed — a green claim with no date is not evidence", async () => {
    const at = Date.parse("2026-08-19T09:00:00-05:00");
    mount({ doctor: { selfTest: selfTestResult({ ranAtMs: at, appVersion: "0.1.0" }) } });
    await screen.findByText("Safety check");
    expect(document.querySelector('[data-slot="selftest-status"]')?.textContent).toBe("Passed");
    expect(document.querySelector('[data-slot="selftest-note"]')?.textContent).toContain(
      new Date(at).toLocaleString(),
    );
  });

  it("does not let a pass from another build stand as proof about this one", async () => {
    mount({ doctor: { selfTest: selfTestResult({ appVersion: "0.0.9" }) } });
    await screen.findByText("Safety check");
    expect(document.querySelector('[data-slot="selftest-status"]')?.textContent).toBe(
      "Out of date",
    );
  });

  it("is loud about a failure and names the check that failed", async () => {
    mount({
      doctor: {
        selfTest: selfTestResult({
          passed: false,
          checks: [
            { id: "userData-is-a-number", passed: false, detail: "read back a BigInt, not a number" },
          ],
        }),
      },
    });
    await screen.findByText("Safety check");
    expect(document.querySelector('[data-slot="selftest-status"]')?.textContent).toBe("FAILED");
    expect(document.querySelector('[data-slot="selftest-failures"]')?.textContent).toMatch(
      /BigInt/,
    );
    expect(document.querySelector('[data-slot="selftest-note"]')?.textContent).toMatch(
      /suspect/i,
    );
  });

  it("runs it over wwb:doctor:selftest and shows the fresh answer", async () => {
    const f = mount();
    await screen.findByText("Safety check");
    act(() => button(card("selftest"), /Run self-test/).click());

    await waitFor(() =>
      expect(document.querySelector('[data-slot="selftest-status"]')?.textContent).toBe("Passed"),
    );
    expect(f.bridge.calls.filter((c) => c.channel === "wwb:doctor:selftest")).toHaveLength(1);
  });
});
