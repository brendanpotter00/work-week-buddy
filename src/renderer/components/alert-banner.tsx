/**
 * The one place the dashboard admits something is wrong.
 *
 * `docs/IMPL_UI.md` §4.5 and PRD §4: a number that cannot be trusted is never
 * rendered bare, and an IPC failure is never rendered as a zero. Both land
 * here, with `role="alert"` so it is announced rather than merely drawn.
 */
import * as React from "react";

import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";

export function AlertBanner({
  variant,
  title,
  lines,
  actionLabel,
  onAction,
}: {
  variant: "error" | "warning";
  title: string;
  lines: readonly string[];
  actionLabel?: string;
  onAction?: () => void;
}): React.ReactElement {
  return (
    <section
      role="alert"
      data-slot="alert-banner"
      data-variant={variant}
      className={cn(
        "mt-4 flex items-start gap-3 rounded-lg border px-4 py-3",
        variant === "error"
          ? "border-destructive/40 bg-destructive/10"
          : "border-border bg-muted",
      )}
    >
      <span aria-hidden="true" className="mt-0.5 text-sm leading-none">
        ⚠︎
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <ul className="mt-1 space-y-0.5">
          {lines.map((line) => (
            <li key={line} className="text-xs text-muted-foreground">
              {line}
            </li>
          ))}
        </ul>
      </div>
      {actionLabel && onAction ? (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </section>
  );
}
