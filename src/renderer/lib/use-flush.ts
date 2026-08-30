/**
 * "Sync now", once — the behaviour, not the button.
 *
 * There are two Sync now buttons: the settings pane's, and the one in the
 * dashboard's status strip. They are deliberately not two implementations.
 * A flush has four outcomes a person has to be able to tell apart —
 *
 *   · it uploaded n rows and the queue is empty
 *   · it uploaded n rows and rows are STILL waiting        ← ok:true, not done
 *   · it failed, with a reason                             ← ok:false
 *   · the IPC call itself never landed                     ← the bridge threw
 *
 * — and a second copy of that reasoning is a second copy that can drift. So the
 * guard, the outcome and the sentence all live here, and the two buttons
 * differ only in how much room they have to print it.
 *
 * ── WHY THE GUARD IS A REF ──────────────────────────────────────────────────
 * `disabled={running}` is a render away from being true. Two clicks inside one
 * frame — a double-click, or a keyboard repeat — both see the old props, and
 * two flushes race for the same pending rows. The ref is checked and set inside
 * the same synchronous call, so the second click cannot get past it whatever
 * React has painted.
 *
 * ── WHY NOTHING HERE BLOCKS OR PROMPTS ──────────────────────────────────────
 * `run()` returns immediately and nothing on this path opens a dialog. The
 * upload happens in main; the renderer holds a boolean and a result object.
 */
import * as React from "react";

import { ipc, messageOf } from "@/renderer/lib/ipc";
import type { FlushResult, SyncConfigState } from "@/shared/ipc-types";

export interface FlushOutcome {
  /** Did the rows actually get there? A partial upload is still `true`. */
  ok: boolean;
  /** One line, short enough for the status strip. */
  text: string;
  /** The whole story, for a `title=`. Equal to `text` when there is no more. */
  detail: string;
}

export interface Flush {
  running: boolean;
  /** The last completed flush in this window, or `null` if none has run. */
  outcome: FlushOutcome | null;
  /** The raw result, for callers that want the numbers rather than the words. */
  result: FlushResult | null;
  /** Never rejects, never throws. A call while one is running is ignored. */
  run: () => void;
}

/** `1 row` / `2 rows`, because "1 rows" reads as a bug in the app. */
function rows(n: number): string {
  return `${String(n)} row${n === 1 ? "" : "s"}`;
}

/**
 * What a finished flush says.
 *
 * Exported and pure so both buttons print the same words and the words are
 * testable without a DOM. `confirmed` rather than `attempted` is the number
 * quoted, because `AGENTS.md` #8 is that a row counts as synced on its PRESENCE
 * in the response and never on the insert having been sent.
 */
export function flushOutcome(r: FlushResult): FlushOutcome {
  if (!r.ok) {
    const why = r.error ?? "no reason given";
    return {
      ok: false,
      text: `Sync failed — ${why}`,
      // Nothing is lost on a failed flush: the local mirror IS the outbox
      // (docs/DATA_MODEL.md), so the rows are still here and still pending.
      detail:
        `Sync failed — ${why}. ` +
        `${rows(r.pendingAfter)} still waiting; nothing has been lost.`,
    };
  }
  if (r.attempted === 0) {
    return { ok: true, text: "Nothing to send", detail: "Everything here is already in the cloud." };
  }
  if (r.pendingAfter > 0) {
    // ok, but NOT done. A green tick over a queue that did not empty is the
    // silent-success half of the same mistake as a silent failure.
    return {
      ok: true,
      text: `Sent ${rows(r.confirmed)}, ${String(r.pendingAfter)} left`,
      detail: `Sent ${rows(r.confirmed)} of ${rows(r.attempted)} attempted. ${rows(
        r.pendingAfter,
      )} still waiting — press Sync now again, or leave it to the background flush.`,
    };
  }
  return {
    ok: true,
    text: `Sent ${rows(r.confirmed)}`,
    detail: `Sent ${rows(r.confirmed)}. Nothing is waiting to upload.`,
  };
}

/**
 * Why this Mac cannot sync at all, or `null` when it can.
 *
 * A DISABLED BUTTON WITH A REASON, never an error on click: a Mac that has
 * never set cloud sync up is not broken, and pressing a live-looking button
 * only to be told "not configured" teaches the owner that the button lies.
 * `null` config means the snapshot has not landed yet — also not a claim, which
 * is why it has its own sentence rather than borrowing the unconfigured one.
 */
export function flushBlockedReason(config: SyncConfigState | null): string | null {
  if (config === null) return "Checking whether cloud sync is set up…";
  if (config.configured) return null;
  if (!config.vaultAvailable) {
    return "This Mac has no keychain available, so no sync token can be stored.";
  }
  if (config.error !== null) return `Cloud sync is not usable: ${config.error}`;
  const hasUrl = config.workerUrl.trim() !== "";
  if (hasUrl && !config.tokenPresent) {
    return "The Worker URL is saved but this Mac’s token is not. Finish setup in Settings ▸ Cloud sync.";
  }
  if (!hasUrl && config.tokenPresent) {
    return "A token is stored but the Worker URL is not. Finish setup in Settings ▸ Cloud sync.";
  }
  return "Cloud sync is not set up. Every hour is still recorded here — Settings ▸ Cloud sync.";
}

/** `onSettled` runs after every completed attempt, successful or not. */
export function useFlush(onSettled?: () => void): Flush {
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<FlushResult | null>(null);
  const [outcome, setOutcome] = React.useState<FlushOutcome | null>(null);

  // See the header: `running` is a render behind, this is not.
  const inFlight = React.useRef(false);
  const settled = React.useRef(onSettled);
  settled.current = onSettled;

  // A resolve that lands after the window closed would set state on nothing.
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = React.useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);

    const done = (o: FlushOutcome, r: FlushResult | null): void => {
      inFlight.current = false;
      if (!alive.current) return;
      setRunning(false);
      setResult(r);
      setOutcome(o);
      settled.current?.();
    };

    let started: Promise<FlushResult>;
    try {
      started = ipc.flush();
    } catch (e) {
      // The bridge itself is missing — a preload that did not load. It throws
      // synchronously, so it never reaches the rejection handler below.
      done({ ok: false, text: `Sync failed — ${messageOf(e)}`, detail: messageOf(e) }, null);
      return;
    }

    started.then(
      (r) => done(flushOutcome(r), r),
      (e: unknown) => {
        const why = messageOf(e);
        done({ ok: false, text: `Sync failed — ${why}`, detail: why }, null);
      },
    );
  }, []);

  return { running, outcome, result, run };
}
