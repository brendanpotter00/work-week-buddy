/**
 * Which Cloudflare account — asked only when it genuinely cannot be settled.
 *
 * One account is not the same as "the first account". A token that reaches
 * several must not have one picked for it: the wrong one means a database and a
 * Worker created on an account the owner did not intend to be billed for, and
 * half their history in a place nothing is pointed at.
 */
import * as React from "react";

import { Field, inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import type { CloudProbeResult } from "@/shared/ipc-types";

export function AccountStep({
  probe,
  accountId,
  busy,
  onAccountId,
  onNext,
  onBack,
}: {
  probe: CloudProbeResult;
  accountId: string;
  busy: boolean;
  onAccountId: (id: string) => void;
  onNext: (id: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const many = probe.accounts.length > 0;
  return (
    <div data-slot="account-step" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Which Cloudflare account?</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {many ? (
            "This token can reach more than one. The database and the Worker are created on the one you pick, so pick the one you mean to be billed for."
          ) : (
            <>
              This token is not allowed to list your accounts, which is normal: Cloudflare
              only allows that for a token with <b>Account Settings · Read</b>.
            </>
          )}
        </p>
        {many ? null : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Paste the <b>Account ID</b> instead. It is in the right-hand column of any
            account’s overview page in the dashboard.
          </p>
        )}
      </div>

      {many ? (
        <div data-slot="account-choices" className="flex flex-col gap-1.5">
          {probe.accounts.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={accountId === a.id ? "default" : "outline"}
              className="justify-start"
              disabled={busy}
              onClick={() => onNext(a.id)}
            >
              {a.name === "" ? a.id : a.name}
            </Button>
          ))}
        </div>
      ) : (
        <Field htmlFor="cloud-account-id" label="Account ID" hint="A 32-character hex string.">
          <input
            id="cloud-account-id"
            type="text"
            spellCheck={false}
            autoComplete="off"
            className={inputClass}
            value={accountId}
            onChange={(e) => onAccountId(e.target.value.trim())}
          />
        </Field>
      )}

      <div className="flex items-center gap-2">
        {many ? null : (
          <Button size="sm" onClick={() => onNext(accountId)} disabled={busy || accountId === ""}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
}
