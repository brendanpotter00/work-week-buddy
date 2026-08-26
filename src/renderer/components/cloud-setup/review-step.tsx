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

import { customDomainUrl, hostnameLabelError, zoneNameError } from "@/cloud/api";
import { Field, inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import { formatAgo } from "@/shared/format";
import type {
  CloudDeployment,
  CloudScopeState,
  EnrolledMachine,
} from "@/shared/ipc-types";

/** What the Address section has collected. Held by `CloudSetup.tsx`. */
export interface AddressChoice {
  /** Ticked. Unticking is always allowed and never costs anything. */
  enabled: boolean;
  /** One DNS label, e.g. `wwb`. */
  label: string;
  /** The zone id when it came from the picker, "" when it was typed. */
  zoneId: string;
  zoneName: string;
}

export function ReviewStep({
  deployment,
  zonesScope,
  machineLabel,
  subdomain,
  address,
  busy,
  revoking,
  onSubdomain,
  onAddress,
  onRevoke,
  onRun,
  onCancel,
}: {
  deployment: CloudDeployment;
  /** Whether the token could LIST domains — a picker or a text field. */
  zonesScope: CloudScopeState;
  /** What this Mac calls itself, from `AppInfo`. Never sent to Cloudflare here. */
  machineLabel: string;
  subdomain: string;
  address: AddressChoice;
  busy: boolean;
  /** The machine id a confirmation is currently open for, if any. */
  revoking: string | null;
  onSubdomain: (v: string) => void;
  onAddress: (next: AddressChoice) => void;
  onRevoke: (machineId: string | null, confirm: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const needsSubdomain = deployment.accountSubdomain === null;
  const ready = !needsSubdomain || subdomain.trim() !== "";
  const thisMac = deployment.machines.find((m) => m.isThisMac) ?? null;
  const workersDevHost =
    deployment.accountSubdomain === null
      ? `wwb-sync.<subdomain>.workers.dev`
      : `wwb-sync.${deployment.accountSubdomain}.workers.dev`;

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
          {address.enabled && addressProblem(address, deployment) === null ? (
            <li data-slot="plan-custom-domain">
              <b>Put it on {customDomainUrl(address.label, address.zoneName)}</b> as well as
              the <code className="rounded bg-muted px-1 py-0.5">workers.dev</code> address.
              Cloudflare adds one DNS record on {address.zoneName} for that name and changes
              nothing else there.
            </li>
          ) : null}
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

      <AddressSection
        deployment={deployment}
        zonesScope={zonesScope}
        workersDevHost={workersDevHost}
        address={address}
        onAddress={onAddress}
      />

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

/**
 * Why this address cannot be sent yet, or null.
 *
 * The ONE rule of this section is that nothing in it can stop the wizard: `Set
 * it up` is never disabled by an address problem. A bad label shows its
 * sentence, the address is simply not sent, and setup goes ahead on the
 * workers.dev address alone.
 */
function addressProblem(a: AddressChoice, deployment: CloudDeployment): string | null {
  if (!a.enabled) return null;
  const shape = hostnameLabelError(a.label) ?? zoneNameError(a.zoneName);
  if (shape !== null) return shape;
  return takenBy(a, deployment) === null ? null : "that hostname is already in use";
}

/** The OTHER Worker already answering at this hostname, if there is one. */
function takenBy(a: AddressChoice, deployment: CloudDeployment): string | null {
  const hostname = `${a.label.trim().toLowerCase()}.${a.zoneName.trim().toLowerCase()}`;
  const match = deployment.workerDomains.find((d) => d.hostname === hostname);
  return match === undefined || match.service === "wwb-sync" ? null : match.service;
}

/**
 * "Also put it on a domain you own" — one section, no disclosure, no sub-panel.
 *
 * DELIBERATELY NOT A NEW SCREEN. The owner's complaint about the previous flow
 * was "very confusing … I don't like how there was like a sub menu", and this
 * whole wizard window exists because of it. So the address choice lives inside
 * the review screen that already existed, and `STEP_ORDER` keeps its nine ids.
 *
 * The section degrades rather than disappears. With `Zone · Read` the domain is
 * a picker; without it, a text field and a sentence saying why. The feature is
 * available either way, because attaching is authorised by a permission the
 * token already has.
 */
function AddressSection({
  deployment,
  zonesScope,
  workersDevHost,
  address,
  onAddress,
}: {
  deployment: CloudDeployment;
  zonesScope: CloudScopeState;
  workersDevHost: string;
  address: AddressChoice;
  onAddress: (next: AddressChoice) => void;
}): React.ReactElement {
  const canPick = zonesScope === "ok" && deployment.zones.length > 0;
  const labelProblem = address.enabled ? hostnameLabelError(address.label) : null;
  const zoneProblem =
    address.enabled && labelProblem === null ? zoneNameError(address.zoneName) : null;
  const preview =
    address.enabled && labelProblem === null && zoneProblem === null
      ? customDomainUrl(address.label, address.zoneName)
      : null;
  const taken = preview === null ? null : takenBy(address, deployment);

  return (
    <section data-slot="address-section">
      <h2 className="text-sm font-medium">Address</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        <code className="rounded bg-muted px-1 py-0.5">{workersDevHost}</code> — Cloudflare
        gives every Worker this one. Setup always turns it on.
      </p>

      <label className="mt-3 flex items-center gap-2 text-xs font-medium">
        <input
          type="checkbox"
          data-slot="custom-domain-toggle"
          checked={address.enabled}
          onChange={(e) => onAddress({ ...address, enabled: e.target.checked })}
        />
        Also put it on a domain you own
      </label>

      {address.enabled ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <input
              id="cloud-domain-label"
              aria-label="Name on the domain"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="wwb"
              className={`${inputClass} max-w-[10rem]`}
              value={address.label}
              onChange={(e) => onAddress({ ...address, label: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">.</span>
            {canPick ? (
              <select
                id="cloud-domain-zone"
                aria-label="Your domain"
                className={inputClass}
                value={address.zoneName}
                onChange={(e) => {
                  const zone = deployment.zones.find((z) => z.name === e.target.value);
                  onAddress({
                    ...address,
                    zoneId: zone?.id ?? "",
                    zoneName: zone?.name ?? e.target.value,
                  });
                }}
              >
                {[...deployment.zones]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((z) => (
                    <option key={z.id} value={z.name}>
                      {z.name}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                id="cloud-domain-zone"
                aria-label="Your domain"
                type="text"
                spellCheck={false}
                autoComplete="off"
                placeholder="your-domain.com"
                className={inputClass}
                value={address.zoneName}
                // Typed, so there is no zone id — the attach carries `zone_name`
                // instead, which needs no zone permission at all.
                onChange={(e) => onAddress({ ...address, zoneId: "", zoneName: e.target.value })}
              />
            )}
          </div>

          {/* The confirmation, not the input. It is what makes a typo visible
              here rather than as a DNS failure minutes later. */}
          {preview === null ? null : (
            <p data-slot="custom-domain-preview" className="text-xs text-muted-foreground">
              → <code className="rounded bg-muted px-1 py-0.5">{preview}</code>
            </p>
          )}
          {labelProblem === null ? null : (
            <p data-slot="custom-domain-error" className="text-xs text-destructive">
              {labelProblem}
            </p>
          )}
          {zoneProblem === null ? null : (
            <p data-slot="custom-domain-error" className="text-xs text-destructive">
              {zoneProblem}
            </p>
          )}
          {/* Said BEFORE anything is created. The probe already read the
              account's Worker domains, so this costs nothing — and being
              refused three minutes into a run is a much worse way to learn it.
              Setup would refuse this hostname anyway: the documented attach has
              no override flag at all. */}
          {taken === null ? null : (
            <p data-slot="custom-domain-taken" className="text-xs text-destructive">
              <b>
                {address.label}.{address.zoneName}
              </b>{" "}
              is already the address of another Worker ({taken}). Setup will not touch it.
              Pick a different name.
            </p>
          )}

          {zonesScope === "missing" ? (
            <p data-slot="zones-unavailable" className="text-xs text-muted-foreground">
              Setup could not list your domains — that needs{" "}
              <code className="rounded bg-muted px-1 py-0.5">Zone · Zone · Read</code> on the
              token, which is optional. Type the domain instead; it must already be on this
              Cloudflare account.
            </p>
          ) : null}
          {zonesScope === "unknown" ? (
            <p data-slot="zones-unavailable" className="text-xs text-muted-foreground">
              Setup could not check which domains are on this account. You can still type
              one, or leave this unticked and use the{" "}
              <code className="rounded bg-muted px-1 py-0.5">workers.dev</code> address.
            </p>
          ) : null}
          {zonesScope === "ok" && deployment.zones.length === 0 ? (
            <p data-slot="zones-unavailable" className="text-xs text-muted-foreground">
              This Cloudflare account has no domains on it, so there is nothing to offer.
              Setup will use the <code className="rounded bg-muted px-1 py-0.5">workers.dev</code>{" "}
              address.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">
        Some work networks block <code className="rounded bg-muted px-1 py-0.5">workers.dev</code>{" "}
        because everybody’s Workers share it. A domain you own usually gets through. Setup
        turns on <b>both</b> and this Mac uses whichever one it can reach.
      </p>
    </section>
  );
}
