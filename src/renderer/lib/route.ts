/**
 * Which view this window is — `docs/IMPL_UI.md` §1.5.
 *
 * The main process opens TWO windows from ONE bundle and tells them apart by
 * the URL it loads: `showDashboard()` loads `#/` and `showOnboarding()` loads
 * `#/onboarding` (`src/main/windows.ts`). Until this file existed the renderer
 * ignored that entirely and mounted the dashboard unconditionally, so the
 * 560×640 non-resizable onboarding window rendered the full 1100-px dashboard
 * squeezed into it — one word per line, stat cards stacked and clipped. The
 * seam had a test on neither side.
 *
 * WHY THE HASH AND NOT THE PATH. The renderer is served over `app://` in the
 * packaged app and over `http://localhost:<port>` in dev, and in both cases the
 * document is `index.html` — there is no server to map `/onboarding` onto it.
 * A hash needs no server, survives `base: "./"`, and is identical in dev and in
 * the bundle. `pathname` is still consulted as a fallback so that a future
 * `loadURL(`${APP_ORIGIN}/onboarding`)` would route rather than silently render
 * the wrong view, which is exactly the failure this file exists to end.
 *
 * No router dependency: there are three views, each of which is a WINDOW the
 * main process opens. Routing here is a lookup, not navigation — nothing in the
 * renderer ever changes the hash.
 */
import * as React from "react";

import { ROUTE } from "@/shared/constants";

export type Route = keyof typeof ROUTE;

/** `#/onboarding?x=1` → `/onboarding`; `''` → `''`. Never throws. */
function normalize(raw: string): string {
  const withoutHash = raw.startsWith("#") ? raw.slice(1) : raw;
  const path = (withoutHash.split(/[?#]/)[0] ?? "").trim();
  if (path === "") return "";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  // `/onboarding/` and `/onboarding` are the same view.
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

/**
 * Pure, and therefore the thing the tests drive: a `Location` is awkward to
 * fake and this takes the two strings that matter.
 *
 * Anything unrecognised is the DASHBOARD. A typo in a hash must not produce a
 * blank window, and the dashboard is the view a user can reach every other way.
 */
export function routeOf(hash: string, pathname = ""): Route {
  const fromHash = normalize(hash);
  // `/index.html` is what both origins serve; it carries no routing information.
  const fromPath = normalize(pathname.replace(/\/index\.html$/i, ""));
  const path = fromHash !== "" ? fromHash : fromPath;
  // A table rather than a chain of ternaries: `ROUTE` is the only definition of
  // what a path means, and matching against it means a fourth window can never
  // be added on one side of this seam alone — which is the bug this whole file
  // exists for.
  for (const [name, value] of Object.entries(ROUTE) as Array<[Route, string]>) {
    if (path === value && name !== "dashboard") return name;
  }
  return "dashboard";
}

function currentRoute(): Route {
  const loc = globalThis.location as Location | undefined;
  return routeOf(loc?.hash ?? "", loc?.pathname ?? "");
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/**
 * The route this window is showing. A string snapshot, so
 * `useSyncExternalStore` compares by value and cannot loop.
 */
export function useRoute(): Route {
  return React.useSyncExternalStore(subscribe, currentRoute, () => "dashboard" as const);
}
