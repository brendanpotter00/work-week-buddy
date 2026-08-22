/**
 * The progress list, and the one screen that ever renders a token.
 *
 * Both ported unchanged from the in-card wizard. `StepList` renders whatever
 * snapshot it is handed; every emission is a COMPLETE snapshot (see
 * `CloudSetupProgress`), so a dropped update costs a stale frame rather than a
 * row stuck on "running" for the session.
 */
import * as React from "react";

import { Button } from "@/renderer/components/ui/button";
import type { CloudStep } from "@/shared/ipc-types";

const STATE_MARK: Record<CloudStep["state"], string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "✗",
};

export function StepList({ steps }: { steps: readonly CloudStep[] }): React.ReactElement {
  return (
    <ol data-slot="cloud-steps" className="flex flex-col gap-1">
      {steps.map((s) => (
        <li
          key={s.id}
          data-step={s.id}
          data-state={s.state}
          className={`flex items-baseline gap-2 text-xs ${
            s.state === "failed"
              ? "text-destructive"
              : s.state === "pending"
                ? "text-muted-foreground"
                : ""
          }`}
        >
          <span aria-hidden className="w-3 shrink-0 tabular-nums">
            {STATE_MARK[s.state]}
          </span>
          <span className="shrink-0">{s.label}</span>
          {s.detail === null ? null : (
            <span className="min-w-0 truncate text-muted-foreground" title={s.detail}>
              — {s.detail}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * This Mac's token, shown once.
 *
 * Reached ONLY when the Keychain refused to store it — the one remaining case
 * where a token has to be readable, because otherwise setup would have worked
 * everywhere except the one machine it was run on. Nothing is ever minted for
 * another machine, so this is the only token this app renders at all.
 *
 * Rendered as element TEXT rather than an input's `value`, so it is not an
 * attribute anywhere and nothing autocompletes or autofills it. It exists in
 * this component's props for as long as the window is open and nowhere else:
 * Cloudflare holds a hash, not the token, so it genuinely cannot be read back.
 */
export function TokenReveal({
  token,
  note,
}: {
  token: string;
  note: string;
}): React.ReactElement {
  const [copied, setCopied] = React.useState<"idle" | "ok" | "failed">("idle");
  return (
    <div
      data-slot="token-reveal"
      className="rounded-md border border-destructive/40 bg-background px-3 py-2"
    >
      <p className="text-xs font-medium">Token for this Mac — shown once</p>
      <code
        data-slot="token-value"
        className="mt-1.5 block break-all rounded bg-muted px-2 py-1.5 text-xs"
      >
        {token}
      </code>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard?.writeText(token).then(
              () => setCopied("ok"),
              () => setCopied("failed"),
            );
          }}
        >
          {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </Button>
        {copied === "failed" ? (
          <span className="text-xs text-muted-foreground">Select it and copy by hand.</span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-destructive">
        This is the only time it will ever be shown. Cloudflare holds only a fingerprint of
        it, so if it is lost the only way out is to run setup again.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
