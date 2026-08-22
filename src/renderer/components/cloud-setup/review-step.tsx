/**
 * "What setup will do" — the screen that makes Cancel honest.
 *
 * The probe that fed it changed nothing, so every line here describes what is
 * ALREADY on the account and what the next button would do to it. A wizard that
 * started creating things on paste would be asking for a second `wwb` database
 * on the wrong account.
 *
 * The machine list is why this screen can exist at all now: the registry is
 * readable, so the owner sees what is enrolled rather than guessing. Revoking is
 * offered here — but never for the Mac the window is running on, because
 * "revoke this Mac" is what running setup again already does, correctly and in
 * the right order (insert, commit, then revoke the old one).
 */
import * as React from "react";

import { Field, inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import { formatAgo } from "@/shared/format";
import type { CloudDeployment, EnrolledMachine } from "@/shared/ipc-types";

export function ReviewStep({
  deployment,
  machineLabel,
  subdomain,
  busy,
  revoking,
  onSubdomain,
  onRevoke,
  onRun,
  onCancel,
}: {
  deployment: CloudDeployment;
  /** What this Mac calls itself, from `AppInfo`. Never sent to Cloudflare here. */
  machineLabel: string;
  subdomain: string;
  busy: boolean;
  /** The machine id a confirmation is currently open for, if any. */
  revoking: string | null;
  onSubdomain: (v: string) => void;
  onRevoke: (machineId: string | null, confirm: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const needsSubdomain = deployment.accountSubdomain === null;
  const ready = !needsSubdomain || subdomain.trim() !== "";
  const thisMac = deployment.machines.find((m) => m.isThisMac) ?? null;

  return (
    <div data-slot="review-step" className="flex flex-col gap-5">
      <section>
        <h2 className="text-sm font-medium">What setup will do</h2>
        <ul data-slot="cloud-plan" className="mt-2 flex flex-col gap-1.5 text-xs">
          <li>
            {deployment.databaseExists ? (
              <>
                <b>Adopt</b> the existing{" "}
                <code className="rounded bg-muted px-1 py-0.5">wwb</code> database
                {deployment.rowsInCloud === null
                  ? ""
                  : ` — it already has ${String(deployment.rowsInCloud)} interval${
                      deployment.rowsInCloud === 1 ? "" : "s"
                    } in it`}
                . Nothing in it is deleted or rewritten.
              </>
            ) : (
              <>
                <b>Create</b> a D1 database called{" "}
                <code className="rounded bg-muted px-1 py-0.5">wwb</code>.
              </>
            )}
          </li>
          <li>
            <b>{deployment.workerExists ? "Redeploy" : "Deploy"}</b> the{" "}
            <code className="rounded bg-muted px-1 py-0.5">wwb-sync</code> Worker, pointed
            at that database.
          </li>
          <li>
            <b>Enrol this Mac</b> — mint a token for this Mac only, store it in this Mac’s
            keychain, and record its fingerprint in the database.{" "}
            <b>Nothing is minted for any other Mac.</b>
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-medium">This Mac</h2>
        <p className="mt-1 text-xs">
          <b>{machineLabel}</b>
          {thisMac === null ? null : (
            <span className="text-muted-foreground">
              {" "}
              · <code className="rounded bg-muted px-1 py-0.5">{thisMac.machineId}</code>
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Every hour recorded here is filed under this machine. Other Macs enrol themselves
          the same way, with their own token.
        </p>
      </section>

      {deployment.machines.length === 0 ? null : (
        <section>
          <h2 className="text-sm font-medium">Machines already enrolled</h2>
          <ul data-slot="enrolled-machines" className="mt-2 flex flex-col gap-2">
            {deployment.machines.map((m) => (
              <MachineRow
                key={m.machineId}
                machine={m}
                busy={busy}
                confirming={revoking === m.machineId}
                onRevoke={onRevoke}
              />
            ))}
          </ul>
        </section>
      )}

      {needsSubdomain ? (
        <Field
          htmlFor="cloud-subdomain"
          label="workers.dev subdomain"
          hint="This account has never chosen one. It is account-wide and appears in the address of everything you deploy, so setup will not pick it for you."
        >
          <input
            id="cloud-subdomain"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="e.g. your-name"
            className={inputClass}
            value={subdomain}
            onChange={(e) => onSubdomain(e.target.value)}
          />
        </Field>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={busy || !ready}>
          {busy ? "Working…" : "Set it up"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MachineRow({
  machine,
  busy,
  confirming,
  onRevoke,
}: {
  machine: EnrolledMachine;
  busy: boolean;
  confirming: boolean;
  onRevoke: (machineId: string | null, confirm: boolean) => void;
}): React.ReactElement {
  const name = machine.label ?? machine.machineId;
  const nowMs = Date.now();
  return (
    <li
      data-slot="machine-row"
      data-this-mac={machine.isThisMac ? "yes" : "no"}
      className="rounded-md border border-border bg-background px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            {name}
            {machine.isThisMac ? (
              <span className="font-normal text-muted-foreground"> (this Mac)</span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            enrolled {new Date(machine.enrolledAtMs).toLocaleDateString()}
            {machine.lastSeenMs === null
              ? " · never seen"
              : ` · last seen ${formatAgo(nowMs - machine.lastSeenMs)} ago`}
          </p>
        </div>
        {/* No Revoke for the Mac you are standing on: "Set up again" already
            does that, and does it in the order that cannot leave this Mac
            offline. */}
        {machine.isThisMac ? (
          <span className="text-xs text-muted-foreground">
            re-running replaces this Mac’s token
          </span>
        ) : confirming ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRevoke(machine.machineId, false)}
          >
            Revoke
          </Button>
        )}
      </div>

      {/* Inline, never a native dialog: nothing here may put a modal on a path
          the user is waiting on. */}
      {confirming ? (
        <div data-slot="revoke-confirm" className="mt-2 border-t border-border pt-2">
          <p className="text-xs">
            Revoking stops <b>{name}</b> from syncing immediately.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing it has already recorded is deleted — its hours stay in the cloud and on
            that Mac, and anything it has not yet sent waits in its outbox. To bring it
            back, run this setup on that Mac again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => onRevoke(machine.machineId, true)}
            >
              Revoke {name}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRevoke(null, false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
