/**
 * "Sync now" for the dashboard's status strip.
 *
 * ── WHY IT REPORTS IN WORDS, IN A ROW THAT HAS NO ROOM ──────────────────────
 * A button that looks identical whether it uploaded twelve rows or failed on an
 * auth error is the silent failure this codebase keeps having to take back out.
 * The strip is one line tall, so the reporting is split by how much each part
 * costs to read:
 *
 *   the button      says what is HAPPENING   — Sync now / Syncing…
 *   the line beside says what HAPPENED       — Sent 12 rows / Sync failed — …
 *   `title=`        says everything else     — attempted vs confirmed, what is
 *                                              still pending, that nothing was
 *                                              lost
 *
 * The short line is where the outcomes have to differ from each other, so it
 * carries the discriminating fact and never a bare "Done". Failure is red and
 * `role="alert"`; success is muted and `role="status"`; the two cannot be
 * mistaken for one another at a glance, which is the actual requirement.
 *
 * It truncates rather than wrapping. The dashboard's minimum width is 880px
 * (`WINDOW_SIZE.dashboard`) and a wrapping strip would push the page's
 * scrollWidth past its viewport, which `npm run smoke` fails on. The full text
 * is one hover away and the colour is not truncatable.
 *
 * ── NOT SET UP IS NOT AN ERROR ──────────────────────────────────────────────
 * On a Mac that has never configured cloud sync the button is DISABLED with the
 * reason beside it, rather than live and answering with a failure. The reason
 * lives in `flushBlockedReason()`, next to the flush itself, so this component
 * holds no policy about what "configured" means.
 */
import * as React from "react";

import { Button } from "@/renderer/components/ui/button";
import { useSyncConfig } from "@/renderer/lib/ipc";
import { flushBlockedReason, useFlush } from "@/renderer/lib/use-flush";

export function SyncNow(): React.ReactElement {
  const config = useSyncConfig();
  const flush = useFlush();

  const blocked = flushBlockedReason(config.data);
  // Short enough for the strip; the sentence itself is the `title`.
  const blockedShort = config.data === null ? "checking…" : "not set up";

  const note = blocked !== null ? null : flush.outcome;

  return (
    <div data-slot="sync-now" className="flex min-w-0 items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        data-slot="sync-now-button"
        aria-label="Sync now"
        title={blocked ?? "Upload anything this Mac has not sent yet"}
        disabled={blocked !== null || flush.running}
        onClick={flush.run}
      >
        {flush.running ? "Syncing…" : "Sync now"}
      </Button>

      {blocked !== null ? (
        <span
          data-slot="sync-now-blocked"
          title={blocked}
          className="min-w-0 truncate text-xs text-muted-foreground"
        >
          {blockedShort}
        </span>
      ) : note !== null ? (
        <span
          data-slot="sync-now-result"
          data-ok={String(note.ok)}
          role={note.ok ? "status" : "alert"}
          title={note.detail}
          className={`min-w-0 truncate text-xs ${
            note.ok ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          {note.text}
        </span>
      ) : null}
    </div>
  );
}

export default SyncNow;
