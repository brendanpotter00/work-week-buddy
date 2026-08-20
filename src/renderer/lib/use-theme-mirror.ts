/**
 * Tells main what colour to paint behind the NEXT window — `docs/IMPL_UI.md`
 * §5.5, second half.
 *
 * Chromium paints `BrowserWindow.backgroundColor` before the renderer's first
 * frame, and main cannot read the renderer's `localStorage`, so the resolved
 * theme has to be mirrored into main-side settings. Without it a dark-themed
 * app flashes white on every launch.
 *
 * The two hex values are `--background` from `src/renderer/index.css` (`:root`
 * and `.dark`). There is no way to read a CSS variable from main; if the
 * palette moves, it moves here too.
 */
import * as React from "react";

import { ipc } from "./ipc";
import { useResolvedTheme } from "./use-resolved-theme";

export const LIGHT_BACKGROUND = "#FFFFFF";
export const DARK_BACKGROUND = "#191919";

export function useThemeMirror(): void {
  const resolved = useResolvedTheme();
  React.useEffect(() => {
    // Cosmetic-only, and one launch behind by design. A failure here costs a
    // flash of the wrong colour on the next launch, never a wrong number, so it
    // must not take the dashboard down or raise a banner over the data.
    try {
      void ipc
        .setSettings({ windowBackground: resolved === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND })
        .catch(() => undefined);
    } catch {
      // no bridge at all; the snapshot hooks already report that loudly.
    }
  }, [resolved]);
}
