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
import { IDLE_TIMEOUT_MIN_RANGE } from "@/shared/constants";
import { INVOKE_CHANNELS } from "@/shared/ipc-types";
import type {
  FlushResult,
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

/** A finished setup — both halves stored and usable. */
const CONFIGURED_SYNC: Partial<SyncConfigState> = {
  workerUrl: "https://x.workers.dev",
  tokenPresent: true,
  configured: true,
};

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

interface Fixture {
  bridge: StubBridge;
  /** Every `setConfig` payload, in order. The token is only ever HERE. */
  writes: Array<{ workerUrl?: string; workerUrlAlt?: string; token?: string }>;
  tests: Array<{ workerUrl?: string; token?: string }>;
  settingsWrites: Array<Partial<UiSettings>>;
  /** One entry per time the card asked main to open the wizard window. */
  wizardOpens: number[];
  state: () => SyncConfigState;
}

function mount(
  over: {
    config?: Partial<SyncConfigState>;
    doctor?: Parameters<typeof doctorReport>[0];
    settings?: Partial<UiSettings>;
    testResult?: SyncTestResult;
    /** Overrides `wwb:sync:flush`; the default below is a clean 2-row upload. */
    flushResult?: Partial<FlushResult>;
  } = {},
): Fixture {
  const writes: Fixture["writes"] = [];
  const tests: Fixture["tests"] = [];
  const settingsWrites: Fixture["settingsWrites"] = [];
  const wizardOpens: number[] = [];
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
        workerUrlAlt: patch.workerUrlAlt ?? config.workerUrlAlt,
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
          alt: null,
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
      ...over.flushResult,
    }),
    "wwb:machine:rename": ({ label }) => appInfo({ machineLabel: label.trim() }),
    "wwb:window:openDashboard": () => undefined,
    "wwb:window:openCloudSetup": () => {
      wizardOpens.push(1);
      return undefined;
    },
  });
  installBridge(bridge);
  renderApp(<Settings />);
  return { bridge, writes, tests, settingsWrites, wizardOpens, state: () => config };
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

/**
 * Open the manual disclosure, if it is not already open.
 *
 * The two fields moved behind it: they only make sense for a setup that
 * already exists, and having them on top of the thing that CREATES one is
 * exactly the "sub menu" the owner complained about. The fields themselves did
 * not change, so every test below reaches them through here.
 */
function openManual(): void {
  const toggle = within(card("sync")).queryByRole("button", {
    name: /enter them by hand|change the url/i,
  });
  if (toggle !== null) act(() => fireEvent.click(toggle));
}

const urlField = (): HTMLInputElement => {
  openManual();
  return within(card("sync")).getByLabelText("Worker URL") as HTMLInputElement;
};
const tokenField = (): HTMLInputElement => {
  openManual();
  return within(card("sync")).getByLabelText("This Mac’s token") as HTMLInputElement;
};
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
        workerUrlAlt: "",
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
        alt: null,
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

describe("one primary path, and the expert fields behind a disclosure", () => {
  const manualFields = (): Element | null =>
    card("sync").querySelector('[data-slot="manual-fields"]');

  it("unconfigured offers Set up, and hides the two fields until asked", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");

    // The thing that CREATES a setup is the primary action, not a link under
    // two fields for a setup that does not exist.
    expect(syncButton(/set up cloud sync/i)).not.toBeNull();
    expect(manualFields()).toBeNull();
    expect(within(card("sync")).queryByLabelText("Worker URL")).toBeNull();
    expect(within(card("sync")).queryByLabelText("This Mac’s token")).toBeNull();

    act(() => syncButton(/set up cloud sync/i).click());
    await waitFor(() => expect(f.wizardOpens).toHaveLength(1));
  });

  it("opens the fields on request, and keeps them open", async () => {
    mount();
    await screen.findByText("Cloud sync");
    openManual();
    expect(manualFields()).not.toBeNull();
    // One-way within a session: collapsing a panel holding a half-typed token
    // would discard it silently, and the token lives in a DOM ref precisely so
    // that it is never in state to restore from.
    expect(
      within(card("sync")).queryByRole("button", { name: /enter them by hand/i }),
    ).toBeNull();
  });

  it("configured shows the URL, Test, Sync now and Set up again", async () => {
    const f = mount({ config: CONFIGURED_SYNC });
    await screen.findByText("Cloud sync");

    const primary = card("sync").querySelector('[data-slot="sync-primary"]');
    expect(primary?.getAttribute("data-configured")).toBe("true");
    expect(primary?.textContent).toContain("https://x.workers.dev");
    expect(primary?.textContent).toContain("stored in the keychain");
    expect(syncButton(/test connection/i)).not.toBeNull();
    expect(syncButton(/sync now/i)).not.toBeNull();

    act(() => syncButton(/set up again/i).click());
    await waitFor(() => expect(f.wizardOpens).toHaveLength(1));
  });

  it("says what Sync now did, in the same words the dashboard's button uses", async () => {
    // Same `useFlush()` as the status strip — one implementation, so the two
    // cannot come to disagree about what a partial upload is called. This pane
    // has room, so it prints the long form.
    mount({ config: CONFIGURED_SYNC, flushResult: { attempted: 5, confirmed: 5 } });
    await screen.findByText("Cloud sync");

    act(() => syncButton(/sync now/i).click());
    const line = (): HTMLElement | null =>
      card("sync").querySelector('[data-slot="sync-flush-result"]');
    await waitFor(() => expect(line()?.textContent).toContain("Sent 5 rows"));
    expect(line()?.getAttribute("data-ok")).toBe("true");
    expect(line()?.getAttribute("role")).toBe("status");
  });

  it("does not swallow a failed Sync now", async () => {
    mount({
      config: CONFIGURED_SYNC,
      flushResult: { ok: false, attempted: 5, confirmed: 0, pendingAfter: 5, error: "403 forbidden" },
    });
    await screen.findByText("Cloud sync");

    act(() => syncButton(/sync now/i).click());
    const line = (): HTMLElement | null =>
      card("sync").querySelector('[data-slot="sync-flush-result"]');
    await waitFor(() => expect(line()?.textContent).toContain("403 forbidden"));
    expect(line()?.getAttribute("data-ok")).toBe("false");
    expect(line()?.getAttribute("role")).toBe("alert");
    expect(line()?.className).toContain("text-destructive");
    // Nothing was lost: the local mirror IS the outbox (docs/DATA_MODEL.md).
    expect(line()?.textContent).toContain("nothing has been lost");
  });

  it("will not start a second Sync now while one is running", async () => {
    const f = mount({ config: CONFIGURED_SYNC });
    await screen.findByText("Cloud sync");

    // Two clicks in one frame: `disabled` has not been painted yet, so what
    // holds is the in-flight ref inside `useFlush()`.
    act(() => {
      syncButton(/sync now/i).click();
      syncButton(/sync now/i).click();
    });
    expect(f.bridge.calls.filter((c) => c.channel === "wwb:sync:flush")).toHaveLength(1);
    // …and Save and Test are held too, so nothing races the upload.
    await waitFor(() => expect(syncButton(/test connection/i).disabled).toBe(true));
  });

  it("opens the fields BY ITSELF when only one half is present", async () => {
    // A URL and no token, or the reverse, is the "finish this" state — and then
    // the fields are the fix rather than the wizard.
    mount({ config: { workerUrl: "https://x.workers.dev", tokenPresent: false } });
    await screen.findByText("Cloud sync");
    expect(manualFields()).not.toBeNull();
  });

  it("opens the fields BY ITSELF when the saved URL is not a URL", async () => {
    mount({ config: { workerUrl: "not-a-url", error: "syncWorkerUrl is not a URL" } });
    await screen.findByText("Cloud sync");
    expect(manualFields()).not.toBeNull();
  });

  it("updates without a reload when main pushes a config change", async () => {
    // The wizard is in another window now, so its finishing has to reach this
    // card. `SyncConfigGateway.write()` pushes; this is the receiving half.
    const f = mount();
    await screen.findByText("Cloud sync");
    expect(document.querySelector('[data-slot="sync-status"]')?.textContent).toBe("Not set up");

    act(() => {
      f.bridge.emit("wwb:push:sync-config", {
        workerUrl: "https://wwb-sync.example.workers.dev",
        workerUrlAlt: "",
        tokenPresent: true,
        configured: true,
        error: null,
        vaultAvailable: true,
      });
    });

    await waitFor(() =>
      expect(document.querySelector('[data-slot="sync-status"]')?.textContent).toBe("Syncing"),
    );
  });
});

describe("the wrong credential in the token field", () => {
  it("warns when a Cloudflare API token is pasted in, and offers the wizard", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");
    // 40 URL-safe characters, no padding — a Cloudflare API token's shape.
    type(tokenField(), "not-a-real-api-token".padEnd(40, "x"));

    const note = card("sync").querySelector('[data-slot="wrong-credential"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("Cloudflare API token, not this Mac’s sync token");
    expect(note?.textContent).toContain("44 characters ending in");

    // And the way out is offered right there.
    act(() => button(note as HTMLElement, /set up cloud sync/i).click());
    await waitFor(() => expect(f.wizardOpens).toHaveLength(1));
  });

  it("warns when a URL is pasted into the token field", async () => {
    mount();
    await screen.findByText("Cloud sync");
    type(tokenField(), "https://wwb-sync.example.workers.dev");
    expect(
      card("sync").querySelector('[data-slot="wrong-credential"]')?.textContent,
    ).toContain("That is a URL, not a token");
  });

  it("says nothing about a token of the right shape, and never blocks Save", async () => {
    const f = mount();
    await screen.findByText("Cloud sync");
    type(urlField(), "https://wwb-sync.example.workers.dev");
    // 44 characters ending in "=" — what `randomBytes(32).toString("base64")`
    // produces, and what this field is for.
    type(tokenField(), `${"A".repeat(43)}=`);
    expect(card("sync").querySelector('[data-slot="wrong-credential"]')).toBeNull();

    // A warning would never block anyway: it warns, it does not refuse.
    act(() => syncButton(/^Save$/).click());
    await waitFor(() => expect(f.writes).toHaveLength(1));
  });

  it("never echoes the value it is warning about", async () => {
    // It runs on a live secret in a renderer. `classifyCredential` returns an
    // enum; nothing here may put the value on screen.
    const apiShaped = "not-a-real-api-token".padEnd(40, "x");
    mount();
    await screen.findByText("Cloud sync");
    type(tokenField(), apiShaped);
    expect(
      card("sync").querySelector('[data-slot="wrong-credential"]')?.textContent ?? "",
    ).not.toContain(apiShaped);
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

  it("writes the idle timeout, over the range the PRD allows", async () => {
    const f = mount();
    const slider = (await screen.findByLabelText(/Idle timeout/)) as HTMLInputElement;
    // Read off the SHARED constant, not typed out again here: a hard-coded "2"
    // in this test would go green against a slider that had drifted away from
    // the bound main actually enforces, which is the exact failure this change
    // exists to remove.
    expect(slider.min).toBe(String(IDLE_TIMEOUT_MIN_RANGE.min));
    expect(slider.max).toBe(String(IDLE_TIMEOUT_MIN_RANGE.max));
    expect(slider.step).toBe("1"); // whole minutes, over 14 stops
    expect(slider.value).toBe("15");

    type(slider, "12");
    await waitFor(() => expect(f.settingsWrites).toContainEqual({ idleTimeoutMin: 12 }));
  });

  it("sends a value below the old 10-minute floor rather than snapping it back", async () => {
    // The renderer half of the double-bound bug. `src/main/ipc.test.ts` holds
    // the other half — a slider that can reach 3 is worth nothing if main
    // clamps it to 10 on arrival.
    const f = mount();
    const slider = (await screen.findByLabelText(/Idle timeout/)) as HTMLInputElement;

    type(slider, "3");
    await waitFor(() => expect(f.settingsWrites).toContainEqual({ idleTimeoutMin: 3 }));
    expect(slider.value).toBe("3");
  });

  it("says what a short timeout costs, and only where it costs something", async () => {
    // At 15 the old wording is the whole truth and stays. Below the old floor
    // it is not: shortening the timeout does not only make the app notice
    // sooner, it splits one session into several and a piece under the
    // `v_countable` floor is recorded and then never counted. The owner asked
    // for the option; the pane owes him the consequence.
    mount();
    const slider = (await screen.findByLabelText(/Idle timeout/)) as HTMLInputElement;
    const hint = () => document.querySelector("#idle-timeout")!.parentElement!.textContent ?? "";

    expect(hint()).toContain("ENDS at your last keystroke");
    expect(hint()).toContain("only makes the app notice sooner");
    expect(hint()).not.toContain("90 seconds");

    type(slider, "2");
    await waitFor(() => expect(hint()).toContain("one session becomes several"));
    // The end stamp promise is unconditional — it is a property of the reducer,
    // true at 2 minutes and at 15.
    expect(hint()).toContain("ENDS at your last keystroke");
    // Named from the stored policy, so it stays honest if `minIntervalS` moves.
    expect(hint()).toContain("90 seconds");
    expect(hint()).not.toContain("only makes the app notice sooner");
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

/**
 * Two addresses, in Settings.
 *
 * Setup can turn on both a `workers.dev` address and one on a domain the owner
 * has, and a given Mac may reach one and not the other. So the card has to say
 * which one is in use, be able to test both, and — when the evidence is on
 * screen — offer the one click that fixes it.
 */
describe("both addresses", () => {
  const twoAddresses = {
    workerUrl: "https://wwb.example.test",
    workerUrlAlt: "https://x.workers.dev",
    tokenPresent: true,
    configured: true,
  };

  it("names the one in use and the one that is not", async () => {
    mount({ config: twoAddresses });
    await screen.findByText("Cloud sync");
    expect(document.body.textContent).toContain("https://wwb.example.test");
    expect(
      document.querySelector('[data-slot="sync-alt-address"]')?.textContent,
    ).toMatch(/https:\/\/x\.workers\.dev.*not in use/);
  });

  it("relabels the button when there IS a second address", async () => {
    mount({ config: twoAddresses });
    await screen.findByText("Cloud sync");
    expect(syncButton(/Test both addresses/)).toBeTruthy();
  });

  it("keeps the old label when there is not", async () => {
    // One address is the ordinary case and must not grow language about a
    // second one that does not exist.
    mount({
      config: { workerUrl: "https://x.workers.dev", tokenPresent: true, configured: true },
    });
    await screen.findByText("Cloud sync");
    expect(syncButton(/Test connection/)).toBeTruthy();
    expect(document.querySelector('[data-slot="sync-alt-address"]')).toBeNull();
  });

  it("says both answered, without turning the second one into a second verdict", async () => {
    mount({
      config: twoAddresses,
      testResult: {
        ok: true,
        reachable: true,
        authorized: true,
        status: 200,
        ms: 184,
        error: null,
        alt: {
          url: "https://x.workers.dev",
          reachable: true,
          status: 200,
          ms: 90,
          error: null,
        },
      },
    });
    await screen.findByText("Cloud sync");
    act(() => syncButton(/Test both addresses/).click());
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sync-test-result"]')?.textContent).toMatch(
        /Reached both addresses/,
      ),
    );
    // Nothing to switch to, so nothing is offered.
    expect(document.querySelector('[data-slot="sync-use-alt"]')).toBeNull();
  });

  it("says NOTHING IS WRONG when the alternate is the one that fails", async () => {
    // The commonest two-address state on a healthy Mac, and it must not read
    // as a fault: the address in use works, and the other one is a spare.
    mount({
      config: twoAddresses,
      testResult: {
        ok: true,
        reachable: true,
        authorized: true,
        status: 200,
        ms: 184,
        error: null,
        alt: {
          url: "https://x.workers.dev",
          reachable: false,
          status: null,
          ms: null,
          error: "that hostname does not resolve from this Mac",
        },
      },
    });
    await screen.findByText("Cloud sync");
    act(() => syncButton(/Test both addresses/).click());
    const line = await waitFor(() => {
      const el = document.querySelector('[data-slot="sync-test-result"]');
      expect(el?.textContent).toMatch(/did not answer/);
      return el!;
    });
    expect(line.getAttribute("data-ok")).toBe("true");
    expect(line.textContent).toMatch(/Nothing is wrong/);
    expect(document.querySelector('[data-slot="sync-use-alt"]')).toBeNull();
  });

  it("offers the switch when the address IN USE is the one that fails", async () => {
    const f = mount({
      config: twoAddresses,
      testResult: {
        ok: false,
        reachable: false,
        authorized: false,
        status: null,
        ms: 20,
        error:
          "could not reach https://wwb.example.test (the connection was closed mid-request)",
        alt: {
          url: "https://x.workers.dev",
          reachable: true,
          status: 200,
          ms: 90,
          error: null,
        },
      },
    });
    await screen.findByText("Cloud sync");
    act(() => syncButton(/Test both addresses/).click());

    const swap = await waitFor(() => {
      const el = document.querySelector('[data-slot="sync-use-alt"]') as HTMLButtonElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(swap.textContent).toContain("https://x.workers.dev");

    await act(async () => {
      swap.click();
    });
    // THE TWO URLS, EXCHANGED, through the ordinary write path — so main
    // rebuilds the flusher and every window hears about it. No new channel and
    // no special case.
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toEqual({
      workerUrl: "https://x.workers.dev",
      workerUrlAlt: "https://wwb.example.test",
    });
  });

  it("says so plainly when neither address answered", async () => {
    mount({
      config: twoAddresses,
      testResult: {
        ok: false,
        reachable: false,
        authorized: false,
        status: null,
        ms: 20,
        error: "could not reach https://wwb.example.test",
        alt: {
          url: "https://x.workers.dev",
          reachable: false,
          status: null,
          ms: null,
          error: "that hostname does not resolve from this Mac",
        },
      },
    });
    await screen.findByText("Cloud sync");
    act(() => syncButton(/Test both addresses/).click());
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sync-test-result"]')?.textContent).toMatch(
        /Neither address answered/,
      ),
    );
    // Nothing is lost, and the card says so rather than leaving it implied.
    expect(document.querySelector('[data-slot="sync-test-result"]')?.textContent).toMatch(
      /every hour stays here until an upload is confirmed/i,
    );
    expect(document.querySelector('[data-slot="sync-use-alt"]')).toBeNull();
  });
});
