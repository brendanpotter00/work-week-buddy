/**
 * The resolved theme, read off the `.dark` class `ThemeProvider` writes to
 * `<html>` — `docs/IMPL_UI.md` §5.2, fix 2.
 *
 * Why not `useTheme().theme`: that can be `"system"`, and `ActivityCalendar`'s
 * `colorScheme` needs `"light" | "dark"`. Resolving `"system"` here would mean a
 * second `prefers-color-scheme` listener that can disagree with the provider's
 * — and the class the provider already wrote is correct by construction.
 *
 * Why not add `resolvedTheme` to the provider: `design/README.md` says copy it
 * verbatim, do not rewrite.
 */
import * as React from "react";

function subscribe(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}

function getSnapshot(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useResolvedTheme(): "light" | "dark" {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
