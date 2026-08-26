/**
 * The last screen.
 *
 * On success it says one thing the old wizard could not: there is nothing to
 * carry to the second Mac. That is the whole point of the registry — a machine
 * enrols itself, so adding one is running this same setup over there.
 */
import * as React from "react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { TokenReveal } from "@/renderer/components/cloud-setup/step-list";
import { Button } from "@/renderer/components/ui/button";
import type { CloudAddressProbe, CloudSetupResult } from "@/shared/ipc-types";

export function DoneStep({
  result,
  onClose,
}: {
  result: CloudSetupResult;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div data-slot="done-step" className="flex flex-col gap-4">
      {result.error === null ? null : (
        <AlertBanner variant="error" title="Setup did not finish" lines={[result.error]} />
      )}

      {/* Rendered on FAILURE too. A run that could not reach anything is
          exactly when knowing which address failed, and why, is worth most —
          it is the only evidence anyone gets to act on. */}
      {result.addresses.length > 1 || !result.ok ? (
        <AddressReport addresses={result.addresses} inUse={result.workerUrl} />
      ) : null}

      {result.ok && pendingCustomDomain(result) !== null ? (
        // NOT an error banner: the run succeeded and sync is on. A new
        // address's certificate takes minutes and sometimes longer, and
        // nothing is waiting on it.
        <AlertBanner
          // NOT "error": the run succeeded.
          variant="warning"
          title={`${hostOf(pendingCustomDomain(result) ?? "")} is not answering yet.`}
          lines={[
            "A new address's certificate normally takes a few minutes and sometimes longer. " +
              "Sync is on and working through the other address, so nothing is waiting on it.",
            "Open Settings → Cloud sync → Test both addresses later; when it answers, " +
              "“Use this one instead” switches over in one click.",
          ]}
        />
      ) : null}

      {result.ok ? (
        <div data-slot="cloud-done">
          <h2 className="text-sm font-medium">Sync is on.</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This Mac will start uploading from the next interval it closes — no relaunch.
          </p>
          {result.addresses.length > 1 || result.workerUrl === null ? null : (
            <code className="mt-2 block break-all rounded bg-muted px-2 py-1.5 text-xs">
              {result.workerUrl}
            </code>
          )}
          {result.addresses.length > 1 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Both are turned on in Cloudflare. This Mac uses the one it can reach; another
              Mac on a different network may use the other. Nothing needs changing when that
              happens.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            <b>To add another Mac:</b> install the app there and run this same setup. It
            will find this database and this Worker and enrol itself. There is nothing to
            copy across.
          </p>
        </div>
      ) : null}

      {result.unstoredToken === null ? null : (
        <TokenReveal
          token={result.unstoredToken}
          note="Everything in the cloud is set up, but this Mac’s keychain would not store its token. Copy it and paste it into Settings → Cloud sync → Enter them by hand."
        />
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Every address, and what it did from THIS Mac.
 *
 * The thing the app could not say before. A work Mac that fails here now gets a
 * sentence per address instead of the word "failed", and the two together are
 * the diagnosis: one hostname failing and another answering is a completely
 * different world from both failing the same way.
 */
function AddressReport({
  addresses,
  inUse,
}: {
  addresses: CloudAddressProbe[];
  inUse: string | null;
}): React.ReactElement | null {
  if (addresses.length === 0) return null;
  return (
    <section data-slot="address-report">
      <h2 className="text-sm font-medium">Addresses</h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {addresses.map((a) => (
          <li
            key={a.url}
            data-slot="address-row"
            data-reachable={a.reachable ? "yes" : "no"}
            className="flex items-baseline gap-2 text-xs"
          >
            <span aria-hidden className="shrink-0">
              {a.reachable ? "✓" : "✗"}
            </span>
            <code className="min-w-0 break-all rounded bg-muted px-1 py-0.5">{a.url}</code>
            <span className="min-w-0 text-muted-foreground">
              {a.reachable
                ? `answered${a.ms === null ? "" : ` in ${String(a.ms)} ms`}`
                : (a.error ?? "did not answer")}
              {a.url === inUse ? " · in use" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The custom domain that is live in Cloudflare but not answering here yet. */
function pendingCustomDomain(result: CloudSetupResult): string | null {
  return result.addresses.find((a) => a.kind === "custom" && !a.reachable)?.url ?? null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
