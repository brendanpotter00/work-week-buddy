/**
 * The safety check — `docs/MACOS.md` calls it the single most important safety
 * mechanism in the product, and until now nothing in the app could run it.
 *
 * WHAT IT PROVES. The jiggler posts synthetic input to keep this Mac
 * "available". The event tap has to be able to tell that input apart from a
 * person's, and it does that with two independent discriminators —
 * `kCGEventSourceUserData` compared as a NUMBER (AGENTS.md trap #4: comparing
 * it against a BigInt literal is always false) and the source pid. If either
 * ever stops working, our own jiggle counts as human input and the tracker
 * reports twenty-four-hour workdays. Silently, and plausibly.
 *
 * WHY A BUTTON AND A DATE, NOT A BUTTON. `scripts/install.sh` hard-gates the
 * install on `--selftest`, so it passed once, on one binary, under one set of
 * TCC grants. macOS updates, a re-grant and a new build all change the thing it
 * was proving. A green claim with no date is not evidence, so the date is the
 * point of this card and the button is only how you refresh it.
 *
 * The result is written to `settings.json` by main and read back through the
 * doctor, so it outlives the process that ran it.
 */
import * as React from "react";

import { SettingsCard } from "@/renderer/components/settings-ui";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import { ipc, messageOf, useAppInfo, type Query } from "@/renderer/lib/ipc";
import type { DoctorReport, SelfTestResult } from "@/shared/ipc-types";

type State =
  | { kind: "never" }
  | { kind: "passed"; result: SelfTestResult; stale: boolean }
  | { kind: "failed"; result: SelfTestResult };

function stateOf(result: SelfTestResult | null, appVersion: string | null): State {
  if (result === null) return { kind: "never" };
  if (!result.passed) return { kind: "failed", result };
  // A pass recorded against a DIFFERENT binary is not a pass for this one: the
  // whole check is about what this build's tap does with this build's events.
  return {
    kind: "passed",
    result,
    stale: appVersion !== null && appVersion !== result.appVersion,
  };
}

export function SelfTestCard({ doctor }: { doctor: Query<DoctorReport> }): React.ReactElement {
  const info = useAppInfo();
  const [fresh, setFresh] = React.useState<SelfTestResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { reload: reloadDoctor } = doctor;

  const result = fresh ?? doctor.data?.selfTest ?? null;
  const state = stateOf(result, info.data?.version ?? null);

  const run = (): void => {
    setRunning(true);
    setError(null);
    ipc.selfTest().then(
      (r) => {
        setFresh(r);
        setRunning(false);
        // Main persisted it; re-read so the card and the doctor agree even if
        // this window is left open for a week.
        reloadDoctor();
      },
      (e: unknown) => {
        setError(messageOf(e));
        setRunning(false);
      },
    );
  };

  const failedChecks = result?.checks.filter((c) => !c.passed) ?? [];

  return (
    <SettingsCard
      id="selftest"
      title="Safety check"
      description="Proves this Mac can tell the jiggler’s own input apart from yours. If it cannot, your hours inflate with time nobody worked."
      action={
        <Badge
          data-slot="selftest-status"
          data-state={state.kind}
          variant={
            state.kind === "passed"
              ? state.stale
                ? "outline"
                : "secondary"
              : state.kind === "failed"
                ? "destructive"
                : "outline"
          }
        >
          {state.kind === "passed"
            ? state.stale
              ? "Out of date"
              : "Passed"
            : state.kind === "failed"
              ? "FAILED"
              : "Never run"}
        </Badge>
      }
    >
      <p data-slot="selftest-note" className="text-xs text-muted-foreground">
        {state.kind === "never"
          ? "This copy has never run the check from inside the app. The installer ran it once; nothing has confirmed it since."
          : state.kind === "failed"
            ? "The last run FAILED. Treat every hour recorded since as suspect, and turn the jiggler off until it passes."
            : state.stale
              ? `Last passed on version ${state.result.appVersion}; this is ${info.data?.version ?? "a newer build"}. Run it again.`
              : `Last passed ${new Date(state.result.ranAtMs).toLocaleString()} on version ${state.result.appVersion}.`}
      </p>

      {failedChecks.length === 0 ? null : (
        <ul data-slot="selftest-failures" className="mt-2 space-y-0.5">
          {failedChecks.map((c) => (
            <li key={c.id} className="text-xs text-destructive">
              {c.id}: {c.detail}
            </li>
          ))}
        </ul>
      )}

      {error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          {running ? "Running…" : "Run self-test"}
        </Button>
      </div>
    </SettingsCard>
  );
}

export default SelfTestCard;
