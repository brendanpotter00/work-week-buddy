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
import type { CloudSetupResult } from "@/shared/ipc-types";

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

      {result.ok ? (
        <div data-slot="cloud-done">
          <h2 className="text-sm font-medium">Sync is on.</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This Mac will start uploading from the next interval it closes — no relaunch.
          </p>
          {result.workerUrl === null ? null : (
            <code className="mt-2 block break-all rounded bg-muted px-2 py-1.5 text-xs">
              {result.workerUrl}
            </code>
          )}
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
