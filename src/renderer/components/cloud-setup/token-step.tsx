/**
 * The Cloudflare API-token screen — and the reason the wizard needed a window.
 *
 * It fixes two of the four failures watched live:
 *
 *   #1 WRONG PLACE. He looked for "Create Token" while on the Worker's page.
 *      API tokens live under the USER PROFILE. Naming the path in a paragraph
 *      did not help someone who was already lost elsewhere, so the screen says
 *      it first, in bold, with a button that goes there.
 *
 *   #3 ONE PERMISSION OF THREE. He made a token with Workers Scripts · Edit and
 *      no D1, and was told "Cloudflare did not accept that API token" — so he
 *      re-copied a perfectly good token. The scope preflight now names the
 *      missing permission BEFORE anything is created, and says in as many words
 *      not to make a new token.
 *
 * ── THE TOKEN NEVER ENTERS REACT STATE ──────────────────────────────────────
 * The input is UNCONTROLLED and the value is held by the parent in a ref, so
 * the secret is in no re-render closure, is never written to the DOM as an
 * attribute, and is never rendered. What state holds is a boolean and an enum.
 * `classifyCredential` is deliberately shaped so it cannot leak the value.
 */
import * as React from "react";

import { Field, inputClass } from "@/renderer/components/settings-ui";
import { Button } from "@/renderer/components/ui/button";
import { TOKEN_PERMISSIONS } from "@/cloud/token-url";
import { classifyCredential, type CredentialShape } from "@/shared/credentials";
import type { CloudProbeResult } from "@/shared/ipc-types";

export function TokenStep({
  inputRef,
  tokenTyped,
  busy,
  probe,
  deepLinkAvailable,
  onType,
  onOpenTokenPage,
  onNext,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  tokenTyped: boolean;
  busy: boolean;
  /** The last probe, when it came back with something to say about the token. */
  probe: CloudProbeResult | null;
  /** False when the pre-filled link could not be built — then say so. */
  deepLinkAvailable: boolean;
  onType: (value: string) => void;
  onOpenTokenPage: () => void;
  onNext: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [shape, setShape] = React.useState<CredentialShape>("unknown");

  const problem = scopeProblem(probe);
  if (problem !== null) {
    return (
      <ScopePanel
        problem={problem}
        onOpenTokenPage={onOpenTokenPage}
        onPasteAgain={() => {
          if (inputRef.current) inputRef.current.value = "";
          setShape("unknown");
          onType("");
        }}
      />
    );
  }

  return (
    <div data-slot="token-step" className="flex flex-col gap-5">
      <section>
        <h2 className="text-sm font-medium">Where it lives</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          API tokens are under <b>your profile</b> — not inside an account, a Worker, or a
          database. <b>If you are looking at a Worker’s page, you are in the wrong place.</b>
        </p>
        <div className="mt-2">
          <Button size="sm" variant="outline" onClick={onOpenTokenPage}>
            Open Cloudflare’s token page
          </Button>
        </div>
        {deepLinkAvailable ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            That link opens <b>Create Custom Token</b> with these three permissions already
            ticked. Check the summary matches before you press <b>Create Token</b>.
          </p>
        ) : (
          <p data-slot="no-deep-link" className="mt-1.5 text-xs text-muted-foreground">
            Go to <b>Create Token → Create Custom Token → Get started</b>. The templates at
            the top of that page will not work: none of them grants D1.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">What it needs</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          All three rows are <b>Account</b> scope.
        </p>
        <ul data-slot="permission-list" className="mt-2 flex flex-col gap-1.5">
          {TOKEN_PERMISSIONS.map((p) => (
            <li key={p.key} className="flex items-baseline gap-2 text-xs">
              <code className="shrink-0 rounded bg-muted px-1 py-0.5">{p.label}</code>
              <CopyButton value={p.label} />
              <span className="min-w-0 text-muted-foreground">— {p.why}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          The dashboard says <b>Edit</b> where Cloudflare’s API docs say <i>Write</i>. They
          are the same permission. Under <b>Account Resources</b>, choose{" "}
          <b>Include → the account you want this on</b>.
        </p>
      </section>

      <section>
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
            onChange={(e) => {
              // The enum, never the value. See `shared/credentials.ts`.
              setShape(classifyCredential(e.target.value));
              onType(e.target.value);
            }}
          />
        </Field>

        <WrongShapeNote shape={shape} />
      </section>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onNext} disabled={busy || !tokenTyped}>
          {busy ? "Checking…" : "Check the token"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Nothing is created yet. The next screen shows what is already on your account.
      </p>
    </div>
  );
}

/** Copies the exact permission string, so it can be pasted into the dashboard. */
function CopyButton({ value }: { value: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      title={`Copy “${value}”`}
      className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "copied" : "⧉"}
    </button>
  );
}

/**
 * The warning for a value pasted into the wrong field.
 *
 * Warns and never blocks: refusing a value we might be wrong about is worse
 * than a wrong-looking one that gets a 401 saying exactly what happened.
 */
function WrongShapeNote({ shape }: { shape: CredentialShape }): React.ReactElement | null {
  if (shape === "sync-token") {
    return (
      <p data-slot="wrong-shape" data-shape={shape} className="mt-2 text-xs text-destructive">
        <b>That looks like this Mac’s sync token, not a Cloudflare API token.</b> The sync
        token is what the app uses <i>after</i> setup — 44 characters, ending in “=”. A
        Cloudflare API token is 40 characters with no “=”. This step needs the second one.
      </p>
    );
  }
  if (shape === "url") {
    return (
      <p data-slot="wrong-shape" data-shape={shape} className="mt-2 text-xs text-destructive">
        <b>That is a URL, not a token.</b> This step needs the credential itself.
      </p>
    );
  }
  return null;
}

type ScopeProblem = "d1" | "workers" | "both" | "rejected" | "inactive" | "network";

/**
 * What the probe said, as one of the cases this screen has words for.
 *
 * `null` means "nothing to report here" — either no probe yet, or one that
 * succeeded and moved the wizard on.
 */
function scopeProblem(probe: CloudProbeResult | null): ScopeProblem | null {
  if (probe === null) return null;
  if (!probe.tokenValid) {
    if (probe.error !== null && probe.error.includes("could not reach")) return "network";
    // A token that verified but is expired or disabled reports its status.
    return probe.tokenStatus !== "unknown" && probe.tokenStatus !== "active"
      ? "inactive"
      : "rejected";
  }
  const scopes = probe.scopes;
  if (scopes === null) return null;
  const d1Missing = scopes.d1 === "missing";
  const workersMissing = scopes.workers === "missing";
  if (d1Missing && workersMissing) return "both";
  if (d1Missing) return "d1";
  if (workersMissing) return "workers";
  return null;
}

function ScopePanel({
  problem,
  onOpenTokenPage,
  onPasteAgain,
}: {
  problem: ScopeProblem;
  onOpenTokenPage: () => void;
  onPasteAgain: () => void;
}): React.ReactElement {
  return (
    <div data-slot="scope-problem" data-problem={problem} className="flex flex-col gap-3">
      {problem === "d1" || problem === "workers" ? (
        <>
          <h2 className="text-sm font-medium">
            That token is real — it is missing one permission.
          </h2>
          <p className="text-xs text-muted-foreground">
            Cloudflare accepted the token.{" "}
            {problem === "d1"
              ? "It is not allowed to see D1 databases, and setup has to create one."
              : "It is not allowed to deploy Workers, and setup has to deploy one."}
          </p>
          <p className="text-xs">
            <b>
              Add{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                {problem === "d1" ? "Account · D1 · Edit" : "Account · Workers Scripts · Edit"}
              </code>{" "}
              to this token
            </b>
            , then paste it again.
          </p>
          <p className="text-xs text-muted-foreground">
            Edit the token you already have rather than making a new one — the token itself
            is fine, and a new one would need all three permissions set again.
          </p>
        </>
      ) : null}

      {problem === "both" ? (
        <>
          <h2 className="text-sm font-medium">
            That token is real, but it has none of the permissions setup needs.
          </h2>
          <p className="text-xs text-muted-foreground">
            Cloudflare accepted the token. It cannot see D1 databases and it cannot deploy
            Workers — which usually means it came from one of the <b>templates</b> at the
            top of the Create Token page rather than from <b>Create Custom Token</b>.
          </p>
          <p className="text-xs">
            Add <code className="rounded bg-muted px-1 py-0.5">Account · D1 · Edit</code> and{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              Account · Workers Scripts · Edit
            </code>
            , then paste it again.
          </p>
        </>
      ) : null}

      {problem === "rejected" ? (
        <>
          <h2 className="text-sm font-medium">Cloudflare did not accept that token.</h2>
          <p className="text-xs text-muted-foreground">
            This is not a permissions problem — Cloudflare does not recognise the string at
            all. Check it was copied whole: they are 40 characters with no spaces.
          </p>
          <p className="text-xs text-muted-foreground">
            If you have only just created it, note that the dashboard shows a token exactly
            once. Re-opening it later shows only its name, not its value.
          </p>
        </>
      ) : null}

      {problem === "inactive" ? (
        <>
          <h2 className="text-sm font-medium">Cloudflare says this token is not active.</h2>
          <p className="text-xs text-muted-foreground">
            An expired or disabled token verifies and then cannot do anything. Create a new
            one.
          </p>
        </>
      ) : null}

      {problem === "network" ? (
        <>
          <h2 className="text-sm font-medium">Could not reach api.cloudflare.com.</h2>
          <p className="text-xs text-muted-foreground">
            Nothing is wrong with the token. Check the network — and on a work Mac, check
            whether the proxy allows <code>api.cloudflare.com</code>.
          </p>
        </>
      ) : null}

      <div className="flex items-center gap-2">
        {problem === "network" ? null : (
          <Button size="sm" variant="outline" onClick={onOpenTokenPage}>
            Open this token in Cloudflare
          </Button>
        )}
        <Button size="sm" onClick={onPasteAgain}>
          {problem === "network" ? "Try again" : "Paste again"}
        </Button>
      </div>
    </div>
  );
}
