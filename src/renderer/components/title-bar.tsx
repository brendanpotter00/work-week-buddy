/**
 * THE TITLE BAR — the strip you grab to move the window.
 *
 * All three windows are `titleBarStyle: "hiddenInset"`, which is to say they
 * have no chrome at all: `fullSizeContentView` hands the web contents every
 * pixel and macOS floats the three buttons on top of them. Nothing is a title
 * bar unless the renderer draws one. The owner's report was the exact shape of
 * that gap — "I have to be right on the border to be able to drag this window
 * around" — and the reason was geometry, not plumbing:
 *
 *   the dashboard's drag region WAS the `<header>`, and the header lives inside
 *   `mx-auto max-w-[1100px] px-8 py-10`. So the draggable box started 40 px
 *   down and 32 px in. The strip across the very top of the window — where the
 *   traffic lights are, and precisely where a hand reaches to move a window —
 *   was not in it, and neither was anything outside the centred column.
 *
 * So the rules this component exists to keep:
 *
 *  1. **Full window width.** It is rendered as a DIRECT CHILD of the `[data-view]`
 *     root, never inside the content column, and the column is re-created
 *     inside it for the text. `test/renderer/title-bar.test.tsx` asserts the
 *     parentage, because "put it back in the column" is a one-line regression
 *     that looks tidier and undoes the whole fix.
 *  2. **It never scrolls away.** `sticky top-0` — the dashboard's page body
 *     scrolls, and a drag strip that scrolls off the top is the same bug in a
 *     different costume. On onboarding and settings the header is a `shrink-0`
 *     flex child that never moves anyway, so sticky is inert there.
 *  3. **It starts below the traffic lights.** `TITLE_BAR_INSET` per window,
 *     checked against `TRAFFIC_LIGHT` — the same numbers `src/main/windows.ts`
 *     hands macOS. Every value is what that window's header already had, so
 *     nothing moved on screen when this landed. That is not tidiness: the
 *     onboarding window is a fixed 560 × 640 that cannot be resized and
 *     `src/main/smoke.ts` requires 16 px of spare height in it.
 *  4. **A drag region swallows clicks.** Everything interactive inside it needs
 *     `[-webkit-app-region:no-drag]`, and a test walks the rendered tree to
 *     make sure nothing new arrives without it. This is the regression that
 *     would trade one broken feel for a worse one.
 *
 * `bg-background` rather than transparent because of rule 2: the dashboard's
 * cards slide UNDER this bar, and a transparent bar would show them through the
 * title.
 */
import * as React from "react";

import { ipc } from "@/renderer/lib/ipc";
import { cn } from "@/renderer/lib/utils";
import { TITLE_BAR_INSET, type AppWindow } from "@/shared/constants";

export function TitleBar({
  window: which,
  className,
  children,
}: {
  /** Which window this is. Picks the inset that clears ITS traffic lights. */
  window: AppWindow;
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const zoom = React.useCallback(() => {
    try {
      // Never rejects into the console: a title bar that logs an error when the
      // window cannot zoom is noise, and the one case that matters (no preload)
      // is already reported by the view's own banner.
      void ipc.zoomWindow().catch(() => undefined);
    } catch {
      /* no bridge — nothing to zoom */
    }
  }, []);

  return (
    <header
      data-slot="title-bar"
      data-window={which}
      onDoubleClick={zoom}
      // An inline number, not a `pt-*` class, because this one has to AGREE
      // with `trafficLightPosition` in `src/main/windows.ts` — and a number
      // that is checked somewhere else needs one home (`shared/constants.ts`).
      style={{ paddingTop: TITLE_BAR_INSET[which] }}
      className={cn(
        "sticky top-0 z-30 w-full shrink-0 bg-background [-webkit-app-region:drag]",
        className,
      )}
    >
      {children}
    </header>
  );
}

export default TitleBar;
