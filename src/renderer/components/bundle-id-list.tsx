/**
 * An editable list of macOS bundle ids.
 *
 * Two of these exist and they mean opposite things, which is why they are one
 * component and not one setting:
 *
 *  - MEETING APPS. The OS reports that the microphone is captured but never by
 *    whom, so a running meeting app is the available proxy (PRD §3.5). Miss one
 *    and a 50-minute call with no mouse movement is recorded as idle.
 *  - MIC-IGNORE APPS. Dictation tools hold the mic more or less continuously.
 *    Left in, one of them makes every waking hour look like a meeting.
 *
 * Each row is one write, immediately. There is no Save button because there is
 * no draft state worth losing: the value is the list, and a list edited behind
 * a Save button that somebody navigates away from is a setting that silently
 * did not change.
 */
import * as React from "react";

import { inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import { X } from "lucide-react";

export function BundleIdList({
  id,
  label,
  hint,
  placeholder,
  values,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  values: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState("");
  const trimmed = draft.trim();
  const duplicate = trimmed !== "" && values.includes(trimmed);

  const add = (): void => {
    if (trimmed === "" || duplicate) return;
    onChange([...values, trimmed]);
    setDraft("");
  };

  return (
    <div data-slot="bundle-list" data-list={id} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{values.length}</span>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>

      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">— none</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {values.map((v) => (
            <li
              key={v}
              data-slot="bundle-row"
              className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{v}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${v}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          id={`bundle-${id}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label={`Add to ${label}`}
          placeholder={placeholder}
          className={inputClass}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // This list may live inside a form one day; never let Enter submit
            // something else while the caret is in an add-a-row field.
            e.preventDefault();
            add();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={add}
          disabled={disabled || trimmed === "" || duplicate}
        >
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role={duplicate ? "alert" : undefined}>
        {duplicate ? "Already in the list." : " "}
      </p>
    </div>
  );
}

export default BundleIdList;
