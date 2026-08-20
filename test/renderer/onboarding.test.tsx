// @vitest-environment jsdom
/**
 * The onboarding window, against a stubbed bridge.
 *
 * Every fact on this screen comes from `wwb:permissions:get` and
 * `wwb:toggles:get` and is updated by `wwb:push:permissions` — there is no
 * hard-coded permission state in the component, and these tests would fail if
 * one appeared.
 *
 * What they are really guarding is the honesty of the copy, because that is
 * what makes the screen worth having:
 *
 *  - Input Monitoring is REQUIRED and its absence is silent (hours read low
 *    forever, no error anywhere).
 *  - Accessibility is genuinely OPTIONAL — it buys the jiggler and nothing
 *    else — and saying so is the difference between an honest permission
 *    screen and one that demands everything.
 *  - `relaunchRequired` is the state a fresh install is actually in, and the
 *    only cure is a restart, so it gets a banner and a button.
 *
 * The 560 × 640 fit is NOT asserted here. jsdom has no layout engine: every
 * element is 0 × 0 and a component test cannot see a squished window. That is
 * `npm run smoke`, which launches the app and measures the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";

import { Onboarding } from "@/renderer/Onboarding";
import type { PermissionKey, PermissionSnapshot, Toggles } from "@/shared/ipc-types";
import {
  grantedSnapshot,
  installBridge,
  installDomStubs,
  makeBridge,
  permissionSnapshot,
  renderApp,
  toggles,
  type StubBridge,
} from "./harness";

interface Setup {
  perms?: PermissionSnapshot;
  toggleState?: Toggles;
  onRelaunch?: () => void;
}

function bridgeFor(s: Setup = {}): StubBridge {
  const perms = s.perms ?? permissionSnapshot();
  const t = s.toggleState ?? toggles({ jigglerAvailable: false, jigglerUnavailableReason: "needs Accessibility" });
  return makeBridge({
    "wwb:permissions:get": () => perms,
    "wwb:permissions:refresh": () => perms,
    "wwb:permissions:request": () => perms,
    "wwb:permissions:openSettings": () => undefined,
    "wwb:permissions:relaunch": () => {
      s.onRelaunch?.();
    },
    "wwb:onboarding:dismiss": () => undefined,
    "wwb:window:openDashboard": () => undefined,
    "wwb:toggles:get": () => t,
    "wwb:toggles:set": (c) => ({ ...t, [c.key]: c.value }),
    "wwb:settings:set": () => ({
      machineLabel: "Work laptop",
      idleTimeoutMin: 15,
      windowBackground: "#FFFFFF",
      meetingApps: [],
      micIgnoreApps: [],
      heatmapThresholdsH: [2, 5, 8] as [number, number, number],
      minIntervalS: 90,
      countJigglerTime: 0 as 0 | 1,
      graceS: 0,
      syncWorkerUrl: "",
    }),
  });
}

/**
 * Waits for the SNAPSHOT, not merely for a render.
 *
 * The first frame has `perms.data === null`, and in that frame every badge says
 * "Checking…" and every pane offers "Grant access" because `promptConsumed` is
 * not known yet. Asserting against that frame passes or fails depending on how
 * loaded the machine is — which is a flaky test, and a flaky test in the file
 * that guards a shipped bug is worse than none.
 */
async function mount(s: Setup = {}) {
  installDomStubs();
  const bridge = bridgeFor(s);
  installBridge(bridge);
  const r = renderApp(<Onboarding />);
  await waitFor(() => {
    const badge = r.container.querySelector('[data-slot="pane-status"]');
    expect(badge?.getAttribute("data-state") ?? "unknown").not.toBe("unknown");
  });
  return { ...r, bridge };
}

const paneOf = (c: HTMLElement, id: PermissionKey): HTMLElement => {
  const el = c.querySelector<HTMLElement>(`[data-permission="${id}"]`);
  if (!el) throw new Error(`no pane for ${id}`);
  return el;
};

const statusOf = (c: HTMLElement, id: PermissionKey): string =>
  paneOf(c, id).querySelector('[data-slot="pane-status"]')?.getAttribute("data-state") ?? "";

const buttonNamed = (c: HTMLElement, name: string): HTMLButtonElement => {
  const el = Array.from(c.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(name),
  );
  if (!el) throw new Error(`no button containing "${name}"`);
  return el;
};

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

describe("it is the onboarding view, not the dashboard", () => {
  it("marks itself so the launched-app smoke run can tell the two apart", async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-view="onboarding"]')).not.toBeNull();
    expect(container.querySelector('[data-view="dashboard"]')).toBeNull();
  });

  it("reads its state over IPC and invents none of it", async () => {
    const { bridge } = await mount();
    expect(bridge.calls.map((c) => c.channel)).toContain("wwb:permissions:get");
    expect(bridge.calls.map((c) => c.channel)).toContain("wwb:toggles:get");
  });
});

describe("the copy says the two things that are otherwise silent", () => {
  it("names Input Monitoring as required and says the failure is invisible", async () => {
    const { container } = await mount();
    const pane = paneOf(container, "inputMonitoring");
    expect(pane.textContent).toMatch(/required/i);
    // AGENTS.md trap #2: hours come out low, forever, with no error anywhere.
    expect(pane.textContent).toMatch(/hours quietly read low/i);
  });

  it("says Accessibility is optional and that tracking is unaffected without it", async () => {
    const { container } = await mount();
    const pane = paneOf(container, "accessibility");
    expect(pane.textContent).toMatch(/optional/i);
    expect(pane.textContent).toMatch(/Tracking is completely unaffected/i);
    // …and that the jiggler is the only thing it buys.
    expect(pane.textContent).toMatch(/jiggler/i);
  });
});

describe("relaunchRequired — the state the owner's install was in", () => {
  it("says restart, loudly, above everything else", async () => {
    const { container } = await mount({ perms: permissionSnapshot() });
    const banner = container.querySelector('[data-slot="relaunch-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toMatch(/restart/i);
    // The pane agrees with the banner rather than claiming "Granted".
    expect(statusOf(container, "inputMonitoring")).toBe("needs-restart");
  });

  it("the restart button closes the interval through the real channel", async () => {
    const relaunched: string[] = [];
    const { container, bridge } = await mount({
      perms: permissionSnapshot(),
      onRelaunch: () => relaunched.push("relaunch"),
    });

    await act(async () => {
      fireEvent.click(buttonNamed(container, "Restart now"));
    });

    // wwb:permissions:relaunch — main closes and journals the open interval
    // BEFORE app.relaunch(). No other channel does that.
    expect(bridge.calls.map((c) => c.channel)).toContain("wwb:permissions:relaunch");
    expect(relaunched).toEqual(["relaunch"]);
  });

  it("has no banner once the live tap has the keyboard bits", async () => {
    const { container } = await mount({ perms: grantedSnapshot() });
    expect(container.querySelector('[data-slot="relaunch-banner"]')).toBeNull();
    expect(statusOf(container, "inputMonitoring")).toBe("granted");
  });
});

describe("a live grant reaches an open window", () => {
  it("drops the restart banner on a wwb:push:permissions snapshot, with no reload", async () => {
    // The window spends its life behind System Settings; main polls TCC at 1 Hz
    // and pushes. If that push did not reach the view, the user would fix the
    // permission and watch the screen keep saying it was broken.
    const { container, bridge } = await mount({ perms: permissionSnapshot() });
    expect(container.querySelector('[data-slot="relaunch-banner"]')).not.toBeNull();

    await act(async () => {
      bridge.emit("wwb:push:permissions", grantedSnapshot());
    });

    expect(container.querySelector('[data-slot="relaunch-banner"]')).toBeNull();
    expect(statusOf(container, "accessibility")).toBe("granted");
  });

  it("subscribes to the permission push for the lifetime of the window", async () => {
    const { bridge, unmount } = await mount();
    expect(bridge.listenerCount("wwb:push:permissions")).toBe(1);
    unmount();
    expect(bridge.listenerCount("wwb:push:permissions")).toBe(0);
  });
});

describe("the jiggler switch never appears on and does nothing", () => {
  /** The switch, once the toggles snapshot has actually landed. */
  async function switchOf(container: HTMLElement, wantDisabled: boolean): Promise<HTMLElement> {
    const sel = '[data-slot="jiggler-row"] [data-slot="switch"]';
    await waitFor(() =>
      expect(container.querySelector(sel)?.hasAttribute("disabled")).toBe(wantDisabled),
    );
    return container.querySelector<HTMLElement>(sel)!;
  }

  it("renders disabled without Accessibility, and says why", async () => {
    const { container } = await mount({
      perms: permissionSnapshot(),
      toggleState: toggles({
        jigglerAvailable: false,
        jigglerUnavailableReason: "needs Accessibility",
      }),
    });
    await switchOf(container, true);
    expect(container.querySelector('[data-slot="jiggler-row"]')?.textContent).toMatch(
      /needs Accessibility/,
    );
  });

  it("becomes clickable when Accessibility is granted", async () => {
    const { container } = await mount({
      perms: grantedSnapshot(),
      toggleState: toggles({ jigglerAvailable: true }),
    });
    await switchOf(container, false);
  });

  it("sends the toggle over wwb:toggles:set rather than flipping locally", async () => {
    const { container, bridge } = await mount({
      perms: grantedSnapshot(),
      toggleState: toggles({ jigglerAvailable: true }),
    });
    const sw = await switchOf(container, false);
    await act(async () => {
      fireEvent.click(sw);
    });
    const set = bridge.calls.find((c) => c.channel === "wwb:toggles:set");
    expect(set?.payload).toMatchObject({ key: "jiggler", value: true });
  });
});

describe("granting, and getting out", () => {
  it("offers the system prompt while it is unspent", async () => {
    const { container, bridge } = await mount({ perms: permissionSnapshot() });
    await act(async () => {
      fireEvent.click(paneOf(container, "accessibility").querySelector("button")!);
    });
    const req = bridge.calls.find((c) => c.channel === "wwb:permissions:request");
    expect(req?.payload).toBe("accessibility");
  });

  it("stops offering a prompt that has been spent, and offers System Settings instead", async () => {
    // The prompt is ONE SHOT per app identity. A button that can no longer do
    // anything is worse than no button.
    const { container } = await mount({
      perms: permissionSnapshot({
        promptConsumed: { inputMonitoring: true, accessibility: true },
      }),
    });
    const pane = paneOf(container, "accessibility");
    expect(pane.textContent).not.toMatch(/Grant access/);
    expect(pane.textContent).toMatch(/Open System Settings/);
  });

  it("opens the right Privacy pane for the pane you asked from", async () => {
    const { container, bridge } = await mount({
      perms: permissionSnapshot({
        promptConsumed: { inputMonitoring: true, accessibility: true },
      }),
    });
    await act(async () => {
      fireEvent.click(
        Array.from(paneOf(container, "inputMonitoring").querySelectorAll("button")).find((b) =>
          (b.textContent ?? "").includes("Open System Settings"),
        )!,
      );
    });
    const open = bridge.calls.find((c) => c.channel === "wwb:permissions:openSettings");
    expect(open?.payload).toBe("inputMonitoring");
  });

  it("can be finished without granting anything", async () => {
    const { container, bridge } = await mount({ perms: permissionSnapshot() });
    await act(async () => {
      fireEvent.click(buttonNamed(container, "Done"));
    });
    expect(bridge.calls.map((c) => c.channel)).toContain("wwb:onboarding:dismiss");
  });

  it("re-reads the permissions on window focus", async () => {
    // Coming back from System Settings is exactly when the answer changed, and
    // exactly when main's 45-second poll has expired.
    const { bridge } = await mount({ perms: permissionSnapshot() });
    const before = bridge.calls.filter((c) => c.channel === "wwb:permissions:refresh").length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(
        bridge.calls.filter((c) => c.channel === "wwb:permissions:refresh").length,
      ).toBeGreaterThan(before),
    );
  });
});

describe("a broken bridge says so instead of rendering a healthy screen", () => {
  it("shows the error rather than an all-clear", async () => {
    installDomStubs();
    // No preload at all: the failure this app treats as loud, not silent.
    installBridge(undefined);
    const { container } = renderApp(<Onboarding />);
    await waitFor(() =>
      expect(container.querySelector('[data-slot="alert-banner"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-slot="alert-banner"]')?.textContent).toMatch(
      /preload did not load/i,
    );
    // …and every pane says "Checking…", never "Granted".
    expect(container.textContent).not.toMatch(/Granted/);
  });
});

describe("no permission polling happens in the renderer", () => {
  it("arms no repeating timer of its own", async () => {
    // AGENTS.md trap #10: this window spends its life hidden behind System
    // Settings and a hidden renderer's timers collapse, which is why the 1 Hz
    // TCC poll lives in main. @testing-library arms a 50 ms real-timer probe of
    // its own, so only intervals at a poll-shaped cadence are interesting.
    const spy = vi.spyOn(globalThis, "setInterval");
    const { unmount } = await mount();
    const ours = spy.mock.calls.filter(([, ms]) => typeof ms === "number" && ms >= 250);
    expect(ours).toEqual([]);
    unmount();
    spy.mockRestore();
  });
});
