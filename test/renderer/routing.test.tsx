// @vitest-environment jsdom
/**
 * THE WINDOW→VIEW SEAM, from both ends.
 *
 * The bug this file exists for: `src/main/windows.ts` opened the onboarding
 * window at `#/onboarding`, and the renderer had no routing at all — `main.tsx`
 * mounted `<App />` unconditionally. The entire 1100-px dashboard rendered
 * inside a 560 × 640 window nobody can resize, one word per line. 708 tests were
 * green the whole time, because every one of them rendered a component directly
 * and none of them ever asked what URL the main process loads.
 *
 * So the test that matters is not "`routeOf` parses a hash". It is: take the
 * URL `windows.ts` REALLY emits, run it through the matcher the renderer REALLY
 * uses, and assert the view. `viewUrl()` is exported from `windows.ts` for
 * exactly that, so a change to either side that separates them fails here.
 *
 * The launched-app smoke run (`npm run smoke`) is the other half — it proves the
 * same pairing in a real Electron window, where a hash could still be dropped by
 * the protocol handler. jsdom cannot see that; it can see everything else.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../fakes/electron"));

import { rendererBase, viewUrl } from "@/main/windows";
import { APP_ORIGIN } from "@/main/protocol";
import { Root } from "@/renderer/Root";
import { routeOf } from "@/renderer/lib/route";
import { ROUTE } from "@/shared/constants";
import {
  defaultHandlers,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  permissionSnapshot,
  renderApp,
} from "./harness";

/** What the renderer sees after Chromium has parsed one of our URLs. */
function locationOf(url: string): { hash: string; pathname: string } {
  const u = new URL(url);
  return { hash: u.hash, pathname: u.pathname };
}

const DEV_BASE = "http://localhost:5173";

describe("the URL main loads is the view the renderer mounts", () => {
  for (const base of [APP_ORIGIN, DEV_BASE]) {
    it(`round-trips both routes over ${base}`, () => {
      // dashboard
      const dash = locationOf(viewUrl(base, ROUTE.dashboard));
      expect(routeOf(dash.hash, dash.pathname)).toBe("dashboard");

      // onboarding — the one that shipped wrong
      const onb = locationOf(viewUrl(base, ROUTE.onboarding));
      expect(routeOf(onb.hash, onb.pathname)).toBe("onboarding");
    });
  }

  it("keeps the hash through URL parsing rather than losing it to the path", () => {
    // `app://` serves a file tree; there is no server to map /onboarding onto
    // index.html. If this ever became a path the packaged app would 404 while
    // dev kept working — "works in dev, dead when packaged", AGENTS.md.
    const u = new URL(viewUrl(APP_ORIGIN, ROUTE.onboarding));
    expect(u.pathname).toBe("/index.html");
    expect(u.hash).toBe("#/onboarding");
  });

  it("falls back to app:// when no dev server is set", () => {
    const prev = process.env["ELECTRON_RENDERER_URL"];
    delete process.env["ELECTRON_RENDERER_URL"];
    try {
      expect(rendererBase()).toBe(APP_ORIGIN);
    } finally {
      if (prev !== undefined) process.env["ELECTRON_RENDERER_URL"] = prev;
    }
  });

  it("uses the dev server when one is set", () => {
    const prev = process.env["ELECTRON_RENDERER_URL"];
    process.env["ELECTRON_RENDERER_URL"] = DEV_BASE;
    try {
      expect(rendererBase()).toBe(DEV_BASE);
    } finally {
      if (prev === undefined) delete process.env["ELECTRON_RENDERER_URL"];
      else process.env["ELECTRON_RENDERER_URL"] = prev;
    }
  });
});

describe("routeOf", () => {
  it("reads the onboarding hash in every shape it can arrive in", () => {
    for (const hash of ["#/onboarding", "/onboarding", "#/onboarding/", "#/onboarding?from=tray"]) {
      expect(routeOf(hash)).toBe("onboarding");
    }
  });

  it("treats anything unrecognised as the dashboard, never as a blank window", () => {
    // A typo in a hash must not produce an empty window. The dashboard is the
    // view reachable every other way, so it is the safe default.
    for (const hash of ["", "#", "#/", "#/nope", "#onboardingx", "#/dashboard"]) {
      expect(routeOf(hash)).toBe("dashboard");
    }
  });

  it("ignores /index.html in the pathname, which carries no routing information", () => {
    expect(routeOf("", "/index.html")).toBe("dashboard");
    expect(routeOf("", "/INDEX.HTML")).toBe("dashboard");
  });

  it("would still route a path form, so a future loadURL cannot silently regress", () => {
    expect(routeOf("", "/onboarding")).toBe("onboarding");
  });

  it("prefers the hash over the path when they disagree", () => {
    expect(routeOf("#/onboarding", "/")).toBe("onboarding");
    expect(routeOf("#/", "/onboarding")).toBe("dashboard");
  });
});

describe("<Root /> mounts the view the hash names", () => {
  function setHash(hash: string): void {
    window.location.hash = hash;
  }

  it("mounts the onboarding view — not the dashboard — at #/onboarding", async () => {
    installDomStubs();
    setHash("#/onboarding");
    installBridge(
      makeBridge({
        ...defaultHandlers(metricsBundle()),
        "wwb:permissions:get": () => permissionSnapshot(),
      }),
    );

    const { container, findByText } = renderApp(<Root />);
    await findByText("Two permissions");

    expect(container.querySelector('[data-view="onboarding"]')).not.toBeNull();
    // The reported symptom, as an assertion: the dashboard must be ABSENT.
    expect(container.querySelector('[data-view="dashboard"]')).toBeNull();
  });

  it("mounts the dashboard at #/", async () => {
    installDomStubs();
    setHash("#/");
    installBridge(makeBridge(defaultHandlers(metricsBundle())));

    const { container, findAllByText } = renderApp(<Root />);
    // "This week" is both a stat-card label and the week-bars heading; either
    // one proves the dashboard rendered.
    expect(await findAllByText("This week")).not.toHaveLength(0);

    expect(container.querySelector('[data-view="dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-view="onboarding"]')).toBeNull();
  });
});
