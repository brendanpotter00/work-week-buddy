/**
 * "What this does" — shown only when nothing is configured.
 *
 * This is the paragraph that used to sit under the `Set up cloud sync…` button
 * in the Settings card, given the room to be read. A returning owner entering
 * through "Set up again…" skips it and starts at the token screen, so it costs
 * no step.
 */
import * as React from "react";

import { Button } from "@/renderer/components/ui/button";

export function IntroStep({
  onNext,
  onCancel,
}: {
  onNext: () => void;
  onCancel: () => void;
}): React.ReactElement {
  // Focused so Return moves on — this screen has one obvious next action.
  const go = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => go.current?.focus(), []);

  return (
    <div data-slot="intro-step" className="flex flex-col gap-4">
      <p className="text-sm">
        Your hours are already safe on this Mac. Cloud sync adds a second copy, and it is
        the only way two Macs add up to one week.
      </p>

      <div>
        <p className="text-xs text-muted-foreground">
          Setting it up creates two things in <b>your own</b> Cloudflare account, on the
          free plan:
        </p>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          <li>
            a <b>D1 database</b> called <code className="rounded bg-muted px-1 py-0.5">wwb</code>{" "}
            — where the hours go
          </li>
          <li>
            a <b>Worker</b> called{" "}
            <code className="rounded bg-muted px-1 py-0.5">wwb-sync</code> — the only thing
            allowed to write to it
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          At this size it costs nothing: about ten writes a day, against a limit of a
          hundred thousand.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        You will need a Cloudflare account and one API token, which takes about two minutes
        to make. <b>This Mac enrols itself — there is no token to carry between machines.</b>
      </p>

      <div className="flex items-center gap-2">
        <Button ref={go} size="sm" onClick={onNext}>
          Continue
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
