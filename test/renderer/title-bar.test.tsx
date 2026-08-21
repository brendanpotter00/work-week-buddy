// @vitest-environment jsdom
/**
 * THE TITLE BAR, in all three windows.
 *
 * The owner's report: "usually on the header you're able to drag the
 * application around, but I have to be right on the border to be able to drag
 * this window around. I want a header, like where the X and the minimize are,
 * to drag this window around."
 *
 * The drag region was implemented and the CSS did compile. What was wrong was
 * GEOMETRY: the dashboard's `[-webkit-app-region:drag]` was on the `<header>`,
 * and the header lives inside `mx-auto max-w-[1100px] px-8 py-10`, so the
 * draggable box started 40 px down and 32 px in. Measured on the launched app
 * before the fix, against a 1100 × 860 window:
 *
 *   drag from 12 px below the top edge  → window did not move
 *   drag from 16 px in from the left    → window did not move
 *   drag from inside the header text    → window moved
 *
 * jsdom has no layout engine, so this file cannot measure pixels — every
 * element here is 0 × 0. What it CAN check is the structure that produced those
 * pixels, and the structure is the whole bug: a bar that is a child of the view
 * root spans the window, a bar that is a child of the content column does not.
 * `npm run smoke` measures the real windows; a human drags them.
 *
 * The second rule is the one that would make the app feel worse rather than
 * better: a drag region swallows clicks on everything it covers, so every
 * control inside the bar has to opt back out. That is asserted by walking the
 * rendered tree rather than by reading the source, because the controls arrive
 * through components (`ThemeToggle`, Radix's `DropdownMenuTrigger`) whose
 * markup this file does not own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import { Onboarding } from "@/renderer/Onboarding";
import { Settings } from "@/renderer/Settings";
import {
  TITLE_BAR_INSET,
  TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_HEIGHT,
  WINDOW_SIZE,
  type AppWindow,
} from "@/shared/constants";
import type { InvokeChannel } from "@/shared/ipc-types";
import {
  appInfo,
  defaultHandlers,
  doctorReport,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  optsOutOfDrag,
  permissionSnapshot,
  renderApp,
  selfTestResult,
  syncConfigState,
  titleBarOf,
  toggles,
  uiSettings,
  type StubBridge,
} from "./harness";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

/** Every channel the three views can ask for, answered with a fixture. */
function bridgeForAll(): StubBridge {
  const t = toggles();
  return makeBridge({
    ...defaultHandlers(metricsBundle()),
    "wwb:app:info": () => appInfo(),
    "wwb:permissions:get": () => permissionSnapshot(),
    "wwb:permissions:refresh": () => permissionSnapshot(),
    "wwb:permissions:request": () => permissionSnapshot(),
    "wwb:permissions:openSettings": () => undefined,
    "wwb:permissions:relaunch": () => undefined,
    "wwb:onboarding:dismiss": () => undefined,
    "wwb:toggles:get": () => t,
    "wwb:toggles:set": (c) => ({ ...t, [c.key]: c.value }),
    "wwb:settings:get": () => uiSettings(),
    "wwb:settings:set": () => uiSettings(),
    "wwb:sync:config": () => syncConfigState(),
    "wwb:doctor:get": () => doctorReport(),
    "wwb:doctor:selftest": () => selfTestResult(),
    "wwb:window:openDashboard": () => undefined,
    "wwb:window:openSettings": () => undefined,
    "wwb:window:zoom": () => undefined,
  });
}

/** The three windows, each mounted with a bridge that answers everything. */
const VIEWS: ReadonlyArray<{ window: AppWindow; el: () => React.ReactElement; marker: string }> = [
  { window: "dashboard", el: () => <App />, marker: "Work Week Buddy" },
  { window: "onboarding", el: () => <Onboarding />, marker: "Two permissions" },
  { window: "settings", el: () => <Settings />, marker: "Settings" },
];

async function mount(v: (typeof VIEWS)[number]): Promise<{
  container: HTMLElement;
  bridge: StubBridge;
}> {
  const bridge = bridgeForAll();
  installBridge(bridge);
  const { container } = renderApp(v.el());
  await waitFor(() => expect(container.textContent).toContain(v.marker));
  return { container, bridge };
}

describe("the drag region spans the top of the window, not the content column", () => {
  for (const v of VIEWS) {
    it(`is a full-width bar at the very top of the ${v.window} window`, async () => {
      const { container } = await mount(v);
      const { root, bar } = titleBarOf(container);

      // THE FIX, as one assertion. A child of the view root is as wide as the
      // window; a child of `mx-auto max-w-[1100px] px-8` is not, and that is
      // exactly where this used to live. Putting it back inside the column is
      // a one-line change that looks tidier and undoes the whole thing.
      expect(bar.parentElement).toBe(root);
      expect(bar.className).toContain("w-full");
      // …and nothing between it and the window edge narrows it.
      expect(root.className).not.toMatch(/max-w-|mx-auto/);
      // At the TOP: nothing renders above it, so the strip the traffic lights
      // sit in belongs to the bar.
      expect(root.firstElementChild).toBe(bar);

      // It is a drag region at all.
      expect(bar.className).toContain("[-webkit-app-region:drag]");

      // And it does not scroll away. The dashboard's page body scrolls; a drag
      // strip that leaves the screen at the first scroll is the same bug in a
      // different costume.
      expect(bar.className).toContain("sticky");
      expect(bar.className).toContain("top-0");
    });

    it(`clears the ${v.window} window's traffic lights without covering them`, async () => {
      const { container } = await mount(v);
      const { bar } = titleBarOf(container);

      // The bar starts at the window's top edge and the buttons float on top of
      // it, so the only thing that can go wrong is the TITLE starting under
      // them. These are the same numbers `src/main/windows.ts` hands macOS.
      const lights = TRAFFIC_LIGHT[v.window];
      const inset = Number.parseInt(bar.style.paddingTop, 10);
      expect(inset).toBe(TITLE_BAR_INSET[v.window]);
      expect(inset).toBeGreaterThanOrEqual(lights.y + TRAFFIC_LIGHT_HEIGHT);
    });
  }

  it("keeps the onboarding title bar exactly as tall as the header it replaced", () => {
    // 560 × 640, `resizable: false`. `src/main/smoke.ts` requires 16 px of
    // spare height inside it and the app currently has about 33. A title bar
    // that added height here would push a button out of a window nobody can
    // resize — so it adds none: 32 px is the `pt-8` the header already had.
    expect(WINDOW_SIZE.onboarding).toEqual({ width: 560, height: 640 });
    expect(TITLE_BAR_INSET.onboarding).toBe(32);
    expect(TITLE_BAR_INSET.settings).toBe(32);
    // The dashboard's was py-10.
    expect(TITLE_BAR_INSET.dashboard).toBe(40);
  });
});

describe("a drag region swallows clicks, so everything in it opts back out", () => {
  for (const v of VIEWS) {
    it(`gives every control in the ${v.window} title bar no-drag`, async () => {
      const { container } = await mount(v);
      const { bar, interactive } = titleBarOf(container);

      const swallowed = interactive.filter((el) => !optsOutOfDrag(el, bar));
      expect(
        swallowed.map(
          (el) =>
            `<${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent ?? ""}>`,
        ),
      ).toEqual([]);
    });
  }

  it("actually finds the dashboard's buttons, so the check above is not vacuous", async () => {
    // A selector that matched nothing would pass the test above forever.
    const { container } = await mount(VIEWS[0]!);
    const { interactive } = titleBarOf(container);
    const labels = interactive.map((el) => el.getAttribute("aria-label"));
    expect(labels).toContain("Settings");
    expect(labels).toContain("Theme");
  });

  it("catches a control that landed in the bar WITHOUT opting out", async () => {
    // The regression, staged: the same walk over a button that has no no-drag
    // ancestor must fail. Without this the assertion above proves nothing about
    // the check itself.
    const { container } = await mount(VIEWS[0]!);
    const { bar } = titleBarOf(container);
    const rogue = document.createElement("button");
    rogue.setAttribute("aria-label", "Rogue");
    bar.appendChild(rogue);

    const { interactive } = titleBarOf(container);
    expect(interactive.some((el) => el.getAttribute("aria-label") === "Rogue")).toBe(true);
    expect(optsOutOfDrag(rogue, bar)).toBe(false);
  });
});

describe("double-click zooms, the way a real title bar does", () => {
  it("asks main to zoom the window that was double-clicked", async () => {
    // macOS gives a `-webkit-app-region: drag` region NO double-click behaviour
    // — measured on Electron 43 against a hiddenInset window, both inside the
    // drag region and in the top 28 px where the native title bar would be.
    // So it is wired by hand, and main scopes it to the sender.
    const { container, bridge } = await mount(VIEWS[0]!);
    const { bar } = titleBarOf(container);

    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    await waitFor(() =>
      expect(bridge.calls.map((c) => c.channel)).toContain("wwb:window:zoom" as InvokeChannel),
    );
  });

  it("does not zoom on a single click", async () => {
    const { container, bridge } = await mount(VIEWS[0]!);
    const { bar } = titleBarOf(container);
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.calls.map((c) => c.channel)).not.toContain("wwb:window:zoom" as InvokeChannel);
  });

  it("survives a missing preload rather than taking the tree down", async () => {
    // `ipc.zoomWindow()` throws SYNCHRONOUSLY when window.wwb is absent, which
    // in a React event handler is an unhandled error, not a rejected promise.
    const { container } = await mount(VIEWS[0]!);
    const { bar } = titleBarOf(container);
    installBridge(undefined);
    const onError = vi.fn();
    window.addEventListener("error", onError);
    expect(() => bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))).not.toThrow();
    window.removeEventListener("error", onError);
    expect(onError).not.toHaveBeenCalled();
  });
});
