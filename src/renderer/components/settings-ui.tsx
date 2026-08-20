/**
 * The four shapes the settings window is built out of.
 *
 * They live here rather than inline so that every section of a long scrolling
 * page has identical spacing, and so the sync card — the one that matters —
 * cannot drift into looking like a different app from the rest.
 *
 * The input is a plain `<input>` with the same classes `device-name.tsx` uses,
 * for the same reason that file uses them: there is no shadcn `Input` in
 * `components/ui/`, and adding one via the CLI would rewrite `index.css`, which
 * `test/renderer/port-fidelity.test.ts` asserts is byte-for-byte the design
 * file.
 */
import * as React from "react";

import { cn } from "@/renderer/lib/utils";

export function SettingsCard({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      data-slot="settings-card"
      data-section={id}
      aria-labelledby={`settings-${id}-title`}
      className="rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`settings-${id}-title`} className="font-heading text-sm font-medium">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** A labelled control with its own help line. The label is always a real one. */
export function Field({
  htmlFor,
  label,
  hint,
  error,
  children,
}: {
  htmlFor: string;
  label: string;
  hint?: string;
  /** Rendered instead of the hint, in destructive ink, with role="alert". */
  error?: string | null;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </label>
      {children}
      {/* Always rendered — a non-breaking space when empty — so validating a
          field does not shove everything below it down by a line. Same rule the
          stat cards keep. */}
      <p
        className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
        role={error ? "alert" : undefined}
      >
        {error ?? hint ?? " "}
      </p>
    </div>
  );
}

export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm outline-none " +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

/**
 * One `label · value` line, for numbers that are read and never edited.
 *
 * `value` takes a node rather than a string so `—` and a real `0` can be
 * different pixels (PRD §4) without this component knowing which is which.
 */
export function ReadRow({
  label,
  value,
  title,
}: {
  label: string;
  value: React.ReactNode;
  title?: string | undefined;
}): React.ReactElement {
  return (
    <div data-slot="read-row" className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right tabular-nums" title={title}>
        {value}
      </span>
    </div>
  );
}
