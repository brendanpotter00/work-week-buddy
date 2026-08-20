/**
 * Naming this Mac.
 *
 * One labelled field and one button, in its own file on purpose: this is the
 * whole renderer surface of device naming, so it can be moved, restyled or
 * dropped into a settings pane later without touching the dashboard.
 *
 * ── WHAT THE COPY PROMISES ──────────────────────────────────────────────────
 * "Every hour recorded on this Mac is labelled with this name" is a literal
 * statement about the schema, not marketing. `work_interval` stores
 * `machine_id` and never the label; the breakdown joins `machine` for a display
 * name. So the rename lands on one row and the whole history — every interval
 * from the first one onwards — reports under the new name immediately. There
 * is no backfill to wait for and no progress to show.
 *
 * ── WHAT IT DOES NOT PROMISE ────────────────────────────────────────────────
 * That the other Mac already knows. Main pushes a heartbeat on rename, but it
 * is best-effort by design and an offline rename is an ordinary thing to do.
 * The message says the name is saved on this Mac, because that is the part that
 * is durably true the moment the call resolves.
 */
import * as React from "react";

import { Button } from "@/renderer/components/ui/button";
import { ipc, messageOf, useAppInfo } from "@/renderer/lib/ipc";

/** Mirrors `MAX_MACHINE_LABEL` in `src/main/device-name.ts`, which enforces it. */
const MAX_LABEL = 60;

type Status = { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string };

export function DeviceName(): React.ReactElement {
  const info = useAppInfo();
  const saved = info.data?.machineLabel ?? "";

  const [draft, setDraft] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  // `null` means "not edited yet", which is not the same as an empty edit. It
  // is what lets the field adopt the name main reports without also stamping
  // over something half-typed the moment a snapshot arrives.
  const value = draft ?? saved;
  const trimmed = value.trim();
  const dirty = trimmed !== saved.trim();
  const canSave = trimmed !== "" && dirty && status.kind !== "saving";

  const save = React.useCallback(() => {
    if (trimmed === "") return;
    setStatus({ kind: "saving" });
    ipc.renameMachine(trimmed).then(
      (next) => {
        // Main's answer, not the guess: it trims and caps, so what came back is
        // what is stored and the field must show that rather than what was typed.
        setDraft(next.machineLabel);
        setStatus({ kind: "saved" });
      },
      (e: unknown) => setStatus({ kind: "error", message: messageOf(e) }),
    );
  }, [trimmed]);

  return (
    <form
      data-slot="device-name"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save();
      }}
    >
      <label htmlFor="device-name-input" className="text-xs text-muted-foreground">
        This Mac’s name
      </label>
      <div className="flex items-center gap-2">
        <input
          id="device-name-input"
          type="text"
          value={value}
          maxLength={MAX_LABEL}
          spellCheck={false}
          autoComplete="off"
          // The id is the join key and the thing a support question is about;
          // it belongs in a tooltip, never in the visible name.
          title={info.data ? `machine id ${info.data.machineId}` : undefined}
          placeholder="MacBook Pro"
          onChange={(e) => {
            setDraft(e.target.value);
            setStatus({ kind: "idle" });
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!canSave}>
          {status.kind === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      <p
        // Always rendered, so saving does not push the card's contents down by
        // a line. Same reason the stat cards keep an empty sub-line.
        className={`text-xs ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
        role={status.kind === "error" ? "alert" : undefined}
      >
        {messageFor(status, trimmed === "" && dirty)}
      </p>
    </form>
  );
}

function messageFor(status: Status, blank: boolean): string {
  if (status.kind === "error") return status.message;
  if (blank) return "A name cannot be empty.";
  if (status.kind === "saved") return "Saved. Every hour recorded here now shows this name.";
  return " ";
}

export default DeviceName;
