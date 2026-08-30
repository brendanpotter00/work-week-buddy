/**
 * 'last signal 3m ago' — the status strip's age cell.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * Because it has a behavioural contract and not just a shape: it must NOT
 * redraw once a second. That is a property of the component rather than of the
 * markup, so it needs somewhere to be stated and somewhere to be tested.
 * `test/renderer/last-signal.test.tsx` does both.
 *
 * ── WHY IT DOES NOT READ THE CLOCK ──────────────────────────────────────────
 * The age is `asOfMs - lastSignalMs`. Both numbers come off ONE snapshot, and
 * `asOfMs` is main's own clock at the instant main built it — so the difference
 * is a fact about that snapshot rather than a subtraction across two processes'
 * clocks. There is no `Date.now()` on this path and no `nowMs` prop, on
 * purpose: `useNowMs()` in `lib/ipc.ts` is armed only while an interval is open
 * (`docs/IMPL_UI.md` §5.7), so anything that reads it inherits a clock that
 * STOPS the moment the session goes idle.
 *
 * That is not hypothetical. This cell used to render
 * `formatAgo(nowMs - status.lastSignalMs)` and it was wrong twice over:
 *
 *  1. Seconds resolution meant sixty redraws a minute, so the dashboard had
 *     two things ticking on it. Only one of them is a stopwatch, and the
 *     stopwatch is the one that earned it (`live-stopwatch.tsx` argues why).
 *  2. When the session went idle `nowMs` froze and `lastSignalMs` stopped
 *     moving too, so the cell stuck at whatever it read when work stopped.
 *     An hour after walking away it still said '15m ago' — a wrong number,
 *     sitting still. Rounding that to the minute would only have made it a
 *     calmer lie, which is why the fix was to change what it subtracts.
 *
 * ── WHY `memo` ──────────────────────────────────────────────────────────────
 * `App` re-renders once a second regardless, because the stopwatch is supposed
 * to move. `memo` is what keeps those renders from reaching this subtree: with
 * both props unchanged, React skips it entirely. Without it the string would
 * merely LOOK still while being recomputed sixty times a minute, which is the
 * cost the owner actually asked to remove.
 *
 * ── WHY 30 s IS OFTEN ENOUGH ────────────────────────────────────────────────
 * Main re-pushes the whole `LiveStatus` every 30 s (`main/ipc.ts`, the
 * keepalive) — `signal` pushes are dropped deliberately, so the keepalive is
 * the only thing that advances `asOfMs`. Twice the resolution this cell
 * displays, so the minute shown is never more than one minute behind.
 */
import * as React from "react";

import { formatAgoMinutes } from "@/shared/format";

export interface LastSignalProps {
  /** `null` renders '—'. Never 'never': no signal yet is not zero seconds ago. */
  readonly lastSignalMs: number | null;
  /** `LiveStatus.asOfMs` — main's clock when it built the snapshot, never ours. */
  readonly asOfMs: number;
}

export const LastSignal = React.memo(function LastSignal({
  lastSignalMs,
  asOfMs,
}: LastSignalProps): React.ReactElement {
  return (
    // `shrink-0`: the strip is a flex row that has to be able to give width
    // back at the window's 880px minimum, and this cell is four words long. The
    // machine label and the sync note shrink; this and the two switches do not.
    <span data-slot="last-signal" className="shrink-0 text-sm text-muted-foreground">
      last signal{" "}
      {/* `tabular-nums` for the same reason as everywhere else on this row:
          '9m ago' → '10m ago' must not shove the two switches to its right. */}
      <span className="tabular-nums">
        {lastSignalMs === null ? "—" : formatAgoMinutes(asOfMs - lastSignalMs)}
      </span>
    </span>
  );
});

export default LastSignal;
