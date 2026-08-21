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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { Settings } from "@/renderer/Settings";
import { INVOKE_CHANNELS } from "@/shared/ipc-types";
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

/**
 * REPLACES a five-test block that drove the "Safety check" card.
 *
 * Those tests were not weakened to make a change pass — the card they exercised
 * no longer exists. The check itself is untouched: `--selftest`, the CLI, the
 * native implementation and the `scripts/install.sh` gate are all as they were,
 * main now runs it automatically when the jiggler is switched on (see
 * `src/main/runtime.test.ts`), and the last result still rides in the doctor
 * report for `npm run doctor`.
 *
 * What is asserted here is only what this window is now responsible for: that
 * the card is gone, and that removing it left nothing broken behind it.
 */
describe("the settings window after the safety-check card was removed", () => {
  it("renders no Safety check card and no way to run one", async () => {
    mount();
    await screen.findByText("Cloud sync");
    expect(screen.queryByText("Safety check")).toBeNull();
    expect(document.querySelector('[data-section="selftest"]')).toBeNull();
    expect(document.querySelector('[data-slot="selftest-status"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /self-?test/i })).toBeNull();
  });

  it("cannot start a self-test at all — the channel no longer exists", async () => {
    // This used to assert the channel was not CALLED on open. It is now
    // stronger and simpler: the renderer has no way to reach the self-test
    // from anywhere, because `wwb:doctor:selftest` was removed with the card.
    // The check posts synthetic events and deliberately blocks the tap for
    // 2.5 s; opening a window must never be a reason for that to happen.
    const f = mount();
    await screen.findByText("About");
    expect(f.bridge.calls.map((c) => c.channel as string)).not.toContain("wwb:doctor:selftest");
    expect([...INVOKE_CHANNELS]).not.toContain("wwb:doctor:selftest");
  });

  it("renders clean when the doctor reports a FAILED self-test", async () => {
    // The failure is surfaced by main through `degraded`, not by this window.
    // What matters here is that a failed report is not something the settings
    // view now chokes on or silently half-renders.
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    try {
      mount({
        doctor: {
          selfTest: selfTestResult({
            passed: false,
            checks: [
              {
                id: "userData-is-a-number",
                passed: false,
                detail: "read back a BigInt, not a number",
              },
            ],
          }),
        },
      });
      await screen.findByText("About");
      expect(screen.queryByText("Safety check")).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
