/**
 * "Set up cloud sync" — the wizard that replaces a terminal.
 *
 * Before this, turning the cloud on meant `npx wrangler login` and a shell
 * script, which is a fine answer for the week you write it and a bad one for
 * the year it breaks in. Everything `scripts/bringup-cloud.sh` does now happens
 * here, from one pasted Cloudflare API token: create or adopt the D1 database,
 * apply the schema, deploy the Worker, mint the two per-machine tokens, turn on
 * the workers.dev address, prove it answers, and store this Mac's half through
 * `safeStorage`. The script stays as the fallback.
 *
 * ── LOOK BEFORE YOU LEAP ────────────────────────────────────────────────────
 * Pasting the token does not start anything. It runs a READ-ONLY probe, and the
 * next screen says what is actually on that account — an existing database and
 * how many intervals are in it, an existing Worker, whether the other Mac
 * already has a token — before offering a button that changes any of it. This
 * account is live; a wizard that started creating things on paste would be
 * asking for a second `wwb` database on the wrong account.
 *
 * ── THE API TOKEN NEVER ENTERS REACT STATE ──────────────────────────────────
 * Same rule, and the same reason, as the sync token in `sync-settings.tsx`: the
 * input is UNCONTROLLED and the value is held in a ref, so the secret is in no
 * re-render closure, is never written to the DOM as an attribute, and is never
 * rendered. What React state holds is a boolean. It differs from
 * `sync-settings.tsx` in ONE way — the ref holds the string rather than the
 * input element — because this is a multi-step wizard and the input has been
 * unmounted by the time the run needs the token. See the ref's own comment.
 *
 * Main does not persist it either: it is used for one call and dropped
 * (`src/main/cloud-setup.ts`), and `test/cloud/secrecy.test.ts` proves it
 * reaches no file, no log and nothing the doctor reads.
 *
 * This Mac's own token is the one exception, and only when the Keychain refuses
 * to store it: then it is rendered once so it can be pasted in by hand.
 *
 * ── NOTHING ASKS WHICH MAC THIS IS ──────────────────────────────────────────
 * Each install enrols itself against its own IOPlatformUUID, so there is no
 * slot to choose and no token to carry anywhere. The failure the old slot
 * detection existed to catch — both Macs syncing, every total right, every hour
 * filed under the wrong laptop for ever — is now unconstructible.
 */
import * as React from "react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { Field, inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import { ipc, messageOf, useCloudSetupProgress } from "@/renderer/lib/ipc";
import type {
  CloudDeployment,
  CloudProbeResult,
  CloudSetupResult,
  CloudStep,
} from "@/shared/ipc-types";

/** Where the owner makes the token. Shown as text — the app opens no browser. */
export const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * The permissions the token needs, in the words the dashboard uses.
 *
 * Kept in the UI as well as in `docs/CLOUDFLARE.md` because this is where
 * somebody is standing when they need them, and a doc they have to go and find
 * is a doc they will guess instead.
 */
export const REQUIRED_PERMISSIONS: ReadonlyArray<{ name: string; why: string }> = [
  { name: "Account · Workers Scripts · Edit", why: "deploy the Worker and its address" },
  { name: "Account · D1 · Edit", why: "create the database and apply the schema" },
  { name: "Account · Account Settings · Read", why: "list your accounts (optional)" },
];

type Phase = "closed" | "token" | "account" | "confirm" | "running" | "done";

export function CloudSetupWizard({
  onFinished,
}: {
  /** Reload the sync card: setup finishing IS a config change. */
  onFinished: () => void;
}): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>("closed");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<CloudProbeResult | null>(null);
  const [accountId, setAccountId] = React.useState("");
  const [subdomain, setSubdomain] = React.useState("");
  const [result, setResult] = React.useState<CloudSetupResult | null>(null);
  const [progress, setProgress] = useCloudSetupProgress();

  /**
   * THE SECRET LIVES HERE AND NOWHERE ELSE.
   *
   * A `useRef` holding the string, rather than `sync-settings.tsx`'s trick of
   * reading it back off the input's `.value`, and the difference is forced:
   * this is a multi-step wizard, so the input is UNMOUNTED by the time the run
   * starts and a DOM ref would be `null` exactly when the token is needed.
   * (That is not hypothetical — it is the first thing
   * `test/renderer/cloud-setup.test.tsx` caught.)
   *
   * The properties that actually matter are unchanged: a ref does not
   * participate in rendering, so the token is in no re-render closure, is never
   * written to the DOM as an attribute, and is never rendered as text. The
   * input stays uncontrolled for the same reason. React state holds a BOOLEAN.
   */
  const tokenRef = React.useRef("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [tokenTyped, setTokenTyped] = React.useState(false);

  const readToken = (): string => tokenRef.current.trim();

  const reset = (): void => {
    tokenRef.current = "";
    if (inputRef.current) inputRef.current.value = "";
    setTokenTyped(false);
    setPhase("closed");
    setProbe(null);
    setResult(null);
    setProgress(null);
    setError(null);
    setAccountId("");
    setSubdomain("");
  };

  const runProbe = (chosenAccountId?: string): void => {
    const apiToken = readToken();
    if (apiToken === "") return;
    setBusy(true);
    setError(null);
    ipc
      .probeCloud({
        apiToken,
        ...(chosenAccountId === undefined ? {} : { accountId: chosenAccountId }),
      })
      .then(
        (r) => {
          setBusy(false);
          setProbe(r);
          if (!r.tokenValid || r.error !== null) {
            setError(r.error ?? "Cloudflare did not accept that token.");
            setPhase("token");
            return;
          }
          if (r.deployment === null) {
            // Either several accounts to choose between, or a token that may
            // not enumerate them at all — then the id is typed in by hand.
            setPhase("account");
            return;
          }
          setAccountId(r.deployment.accountId);
          setSubdomain(r.deployment.accountSubdomain ?? "");
          setPhase("confirm");
        },
        (e: unknown) => {
          setBusy(false);
          setError(messageOf(e));
        },
      );
  };

  const run = (): void => {
    const apiToken = readToken();
    if (apiToken === "" || accountId === "") return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setPhase("running");
    ipc
      .runCloudSetup({
        apiToken,
        accountId,
        ...(subdomain.trim() === "" ? {} : { subdomain: subdomain.trim() }),
      })
      .then(
        (r) => {
          setBusy(false);
          setResult(r);
          setPhase("done");
          // The token has done its job. Drop it before anything else renders,
          // so a finished wizard is not a credential still in memory.
          tokenRef.current = "";
          if (inputRef.current) inputRef.current.value = "";
          setTokenTyped(false);
          if (r.ok) onFinished();
        },
        (e: unknown) => {
          setBusy(false);
          setError(messageOf(e));
          setPhase("confirm");
        },
      );
  };

  if (phase === "closed") {
    return (
      <div data-slot="cloud-setup" data-phase="closed" className="mt-4">
        <Button size="sm" variant="outline" onClick={() => setPhase("token")}>
          Set up cloud sync…
        </Button>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Creates the database, deploys the Worker and fills both fields above. Safe to
          run again — an existing setup is adopted, never duplicated.
        </p>
      </div>
    );
  }

  return (
    <div
      data-slot="cloud-setup"
      data-phase={phase}
      className="mt-4 rounded-md border border-border bg-muted/40 p-4"
    >
      {error === null ? null : (
        <AlertBanner variant="error" title="Setup could not continue" lines={[error]} />
      )}

      {phase === "token" ? (
        <TokenStep
          inputRef={inputRef}
          tokenTyped={tokenTyped}
          busy={busy}
          onType={(value) => {
            tokenRef.current = value;
            setTokenTyped(value.trim() !== "");
            setError(null);
          }}
          onNext={() => runProbe()}
          onCancel={reset}
        />
      ) : null}

      {phase === "account" && probe !== null ? (
        <AccountStep
          probe={probe}
          accountId={accountId}
          busy={busy}
          onAccountId={setAccountId}
          onNext={(id) => {
            setAccountId(id);
            runProbe(id);
          }}
          onBack={() => setPhase("token")}
        />
      ) : null}

      {phase === "confirm" && probe?.deployment != null ? (
        <ConfirmStep
          deployment={probe.deployment}
          subdomain={subdomain}
          busy={busy}
          onSubdomain={setSubdomain}
          onRun={run}
          onCancel={reset}
        />
      ) : null}

      {phase === "running" || phase === "done" ? (
        <StepList steps={result?.steps ?? progress?.steps ?? []} />
      ) : null}

      {phase === "done" && result !== null ? (
        <DoneStep result={result} onClose={reset} />
      ) : null}
    </div>
  );
}

function TokenStep({
  inputRef,
  tokenTyped,
  busy,
  onType,
  onNext,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  tokenTyped: boolean;
  busy: boolean;
  onType: (value: string) => void;
  onNext: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">One Cloudflare API token</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          In the Cloudflare dashboard, go to <b>My Profile → API Tokens → Create Token →
          Create Custom Token</b> and give it these permissions:
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {REQUIRED_PERMISSIONS.map((p) => (
            <li key={p.name} className="text-xs">
              <code className="rounded bg-background px-1 py-0.5">{p.name}</code>
              <span className="text-muted-foreground"> — {p.why}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Under <b>Account Resources</b>, include the account you want this on.{" "}
          <code className="rounded bg-background px-1 py-0.5">{TOKEN_URL}</code>
        </p>
      </div>

      <Field
        htmlFor="cloud-api-token"
        label="Cloudflare API token"
        hint="Used for this setup and then forgotten. It is never saved, never written to a file, and never shown again."
      >
        {/* UNCONTROLLED. The value never reaches React state, a re-render
            closure, or the DOM as an attribute. See the file header. */}
        <input
          id="cloud-api-token"
          ref={inputRef}
          type="password"
          name="wwb-cf-api-token"
          spellCheck={false}
          autoComplete="off"
          placeholder="paste the token"
          className={inputClass}
          onChange={(e) => onType(e.target.value)}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onNext} disabled={busy || !tokenTyped}>
          {busy ? "Checking…" : "Check the token"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Nothing is created yet. The next screen shows what is already on the account.
      </p>
    </div>
  );
}

function AccountStep({
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
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Which Cloudflare account?</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {many
            ? "This token can reach more than one. The database and the Worker are created on the one you pick, so pick the one you mean to be billed for."
            : "This token cannot list accounts, which is normal — Cloudflare only allows that for API keys. Paste the Account ID from the dashboard (any account’s overview page shows it in the right-hand column)."}
        </p>
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

function ConfirmStep({
  deployment,
  subdomain,
  busy,
  onSubdomain,
  onRun,
  onCancel,
}: {
  deployment: CloudDeployment;
  subdomain: string;
  busy: boolean;
  onSubdomain: (v: string) => void;
  onRun: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const needsSubdomain = deployment.accountSubdomain === null;
  const ready = !needsSubdomain || subdomain.trim() !== "";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">What setup will do</h3>
        <ul data-slot="cloud-plan" className="mt-2 flex flex-col gap-1 text-xs">
          <li>
            {deployment.databaseExists ? (
              <>
                <b>Adopt</b> the existing <code>wwb</code> database
                {deployment.rowsInCloud === null
                  ? ""
                  : ` — it already has ${String(deployment.rowsInCloud)} interval${
                      deployment.rowsInCloud === 1 ? "" : "s"
                    } in it`}
                . Nothing in it is deleted or rewritten.
              </>
            ) : (
              <>
                <b>Create</b> a D1 database called <code>wwb</code>.
              </>
            )}
          </li>
          <li>
            {deployment.workerExists ? (
              <>
                <b>Redeploy</b> the <code>wwb-sync</code> Worker.
              </>
            ) : (
              <>
                <b>Deploy</b> the <code>wwb-sync</code> Worker.
              </>
            )}
          </li>
          <li>
            <b>Enrol this Mac</b> — mint a token for this Mac only, store it in this
            Mac’s keychain, and record its fingerprint in the database.{" "}
            <b>Nothing is minted for any other Mac.</b>
          </li>
        </ul>
      </div>

      {deployment.machines.length === 0 ? null : (
        <div
          data-slot="enrolled-machines"
          className="rounded-md border border-border bg-background px-3 py-2"
        >
          <p className="text-xs font-medium">Machines already enrolled</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
            {deployment.machines.map((m) => (
              <li key={m.machineId} data-this-mac={m.isThisMac ? "yes" : "no"}>
                <b>{m.label ?? m.machineId}</b>
                {m.isThisMac ? " (this Mac) — re-running replaces this Mac’s token" : null}
              </li>
            ))}
          </ul>
        </div>
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

const STATE_MARK: Record<CloudStep["state"], string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "✗",
};

function StepList({ steps }: { steps: readonly CloudStep[] }): React.ReactElement {
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

function DoneStep({
  result,
  onClose,
}: {
  result: CloudSetupResult;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {result.error === null ? null : (
        <AlertBanner variant="error" title="Setup did not finish" lines={[result.error]} />
      )}

      {result.ok ? (
        <p data-slot="cloud-done" className="text-xs">
          Sync is on. This Mac will start uploading from the next interval it closes — no
          relaunch. <b>To add another Mac:</b> install the app there and run this same
          setup. It will find this database and this Worker and enrol itself. There is
          nothing to copy across.
        </p>
      ) : null}

      {result.unstoredToken === null ? null : (
        <TokenReveal
          owner="this Mac"
          token={result.unstoredToken}
          note="Everything in the cloud is set up, but this Mac’s keychain would not store its token. Paste it into “This Mac’s token” above."
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
 * A token, shown once.
 *
 * Rendered as element TEXT rather than an input's `value`, so it is not an
 * attribute anywhere and nothing autocompletes or autofills it. It exists in
 * this component's props for as long as the panel is open and is gone when the
 * wizard is closed — and it exists nowhere else at all, because Cloudflare will
 * not give a secret back.
 */
function TokenReveal({
  owner,
  token,
  note,
}: {
  owner: string;
  token: string;
  note: string;
}): React.ReactElement {
  const [copied, setCopied] = React.useState<"idle" | "ok" | "failed">("idle");
  return (
    <div
      data-slot="token-reveal"
      className="rounded-md border border-destructive/40 bg-background px-3 py-2"
    >
      <p className="text-xs font-medium">Token for {owner} — shown once</p>
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
        This is the only time it will ever be shown. Cloudflare cannot read a secret back,
        so if it is lost the only way out is to mint a new one.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

export default CloudSetupWizard;
