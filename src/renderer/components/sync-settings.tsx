/**
 * The Cloud sync card — one card, three states, ONE codepath.
 *
 * ── WHAT WAS WRONG WITH IT ──────────────────────────────────────────────────
 * It showed `Worker URL` and `This Mac's token` — fields that only make sense
 * for a setup that already exists — with `Set up cloud sync…`, the thing that
 * CREATES one, buried underneath and opening a bordered sub-panel INSIDE the
 * card. Three levels deep, with the expert affordance on top. The owner's words:
 * "this onboarding flow is very confusing … I don't like how there was like a
 * sub menu."
 *
 * So: exactly one primary path, chosen by whether sync is configured, and the
 * two expert fields behind a disclosure. The wizard itself moved out to its own
 * window (`ROUTE.cloudSetup`).
 *
 * ── STILL ONE COMPONENT ─────────────────────────────────────────────────────
 * One `SyncSettings`, one pair of `<Field>`s, one `save()`, one `runTest()`.
 * All `configured` decides is which sentence shows, which button is primary,
 * and whether the disclosure starts open. There is no second component to
 * drift out of step with this one.
 *
 * ── THE TOKEN NEVER ENTERS REACT STATE ──────────────────────────────────────
 * The token input is UNCONTROLLED, held by a ref, and that is a security
 * decision rather than a style one. A controlled `value={token}` would put the
 * secret in a React fibre, in every re-render's closure, in a component-tree
 * snapshot and — depending on the renderer — in a `value` attribute in the DOM.
 * With a ref it exists in exactly one DOM node's `.value` property and in the
 * argument to one IPC call, and the field is cleared the moment that call
 * resolves. What React state holds is a BOOLEAN and an ENUM.
 *
 * The other direction is enforced by the contract itself: `SyncConfigState` has
 * `tokenPresent: boolean` and no field a token could ride back on.
 *
 * ── WHY "TEST" IS A SEPARATE BUTTON ─────────────────────────────────────────
 * Saving a wrong URL is silent. The flusher retries in the background, the
 * doctor says `configured: true`, and the only symptom is that the other Mac's
 * hours never appear — a week later. `wwb:sync:test` calls `/health` and then
 * one authenticated read, stores nothing, and turns that into an answer while
 * the field is still on screen.
 */
import * as React from "react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { Field, ReadRow, SettingsCard, inputClass } from "@/renderer/components/settings-ui";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import { Separator } from "@/renderer/components/ui/separator";
import { ipc, messageOf, type Query } from "@/renderer/lib/ipc";
import { syncHealthView, workerUrlError, type SyncTone } from "@/renderer/lib/sync-health";
import { classifyCredential, type CredentialShape } from "@/shared/credentials";
import { formatAgo, formatCount } from "@/shared/format";
import type { DoctorReport, SyncConfigState, SyncTestResult } from "@/shared/ipc-types";

const TONE_VARIANT: Record<SyncTone, "default" | "secondary" | "destructive" | "outline"> = {
  unknown: "outline",
  unconfigured: "outline",
  healthy: "secondary",
  failing: "destructive",
};

/** '3m ago' with the absolute time in the tooltip. `null` is '—', never 'never'. */
function Ago({ ms, nowMs }: { ms: number | null; nowMs: number }): React.ReactElement {
  if (ms === null) return <span className="text-muted-foreground">—</span>;
  return <span title={new Date(ms).toLocaleString()}>{formatAgo(nowMs - ms)} ago</span>;
}

type Busy = "idle" | "testing" | "saving" | "flushing";

export function SyncSettings({
  config,
  doctor,
}: {
  config: Query<SyncConfigState>;
  doctor: Query<DoctorReport>;
}): React.ReactElement {
  const saved = config.data;
  const health = syncHealthView(saved, doctor.data);
  const sync = doctor.data?.sync ?? null;
  const configured = saved?.configured === true;

  // `null` means "not edited", which is not the same as an empty edit — the
  // same rule `device-name.tsx` uses. It is what lets the field adopt the stored
  // URL when the snapshot arrives without stamping over something half-typed.
  const [urlDraft, setUrlDraft] = React.useState<string | null>(null);
  const url = urlDraft ?? saved?.workerUrl ?? "";
  const urlProblem = urlDraft === null ? null : workerUrlError(urlDraft);

  // The secret lives HERE and nowhere else. See the header.
  const tokenRef = React.useRef<HTMLInputElement>(null);
  const [tokenTyped, setTokenTyped] = React.useState(false);
  const [tokenShape, setTokenShape] = React.useState<CredentialShape>("unknown");

  const [busy, setBusy] = React.useState<Busy>("idle");
  const [test, setTest] = React.useState<SyncTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);
  const nowMs = Date.now();

  const { reload: reloadDoctor } = doctor;

  /**
   * Whether the manual fields are on screen.
   *
   * ONE-WAY within a session: once opened it stays open until the window
   * closes. Collapsing a panel that holds a half-typed token would discard it
   * silently, and the token lives in a DOM ref precisely so that it is never in
   * state to restore from.
   */
  const [opened, setOpened] = React.useState(false);
  const halfConfigured =
    saved !== null && saved.tokenPresent !== (saved.workerUrl.trim() !== "");
  // It opens BY ITSELF when the fields are the fix rather than the wizard: a
  // saved URL that is not a URL, or exactly one half present — which is the
  // "finish this" state `sync-health.ts` already writes a sentence for.
  const manualOpen = opened || saved?.error != null || halfConfigured;

  /**
   * Read the field, then blank it — in that order, and never into state.
   *
   * Whitespace goes here rather than in main: a token pasted out of a terminal
   * arrives with a trailing newline, and it must WORK, not merely be rejected
   * politely. Main trims too (`token.ts`), so the two agree about what was
   * entered.
   */
  const takeToken = (): string | undefined => {
    const raw = tokenRef.current?.value ?? "";
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const clearTokenField = (): void => {
    if (tokenRef.current) tokenRef.current.value = "";
    setTokenTyped(false);
    setTokenShape("unknown");
  };

  const patch = (): { workerUrl?: string; token?: string } => {
    const token = takeToken();
    return {
      // Sent only when edited: re-saving the same URL is not what the owner
      // asked for and would be a needless write.
      ...(urlDraft === null ? {} : { workerUrl: urlDraft.trim() }),
      ...(token === undefined ? {} : { token }),
    };
  };

  const runTest = (): void => {
    // The same check main runs, run first so a typo is answered beside the
    // field instead of after a round trip that could not have worked.
    if (urlProblem !== null) return;
    setBusy("testing");
    setError(null);
    setTest(null);
    ipc.testSyncConfig(patch()).then(
      (r) => {
        setTest(r);
        setBusy("idle");
      },
      (e: unknown) => {
        setError(messageOf(e));
        setBusy("idle");
      },
    );
  };

  const save = (): void => {
    if (urlProblem !== null) return;
    setBusy("saving");
    setError(null);
    setSavedNote(null);
    ipc.setSyncConfig(patch()).then(
      (next) => {
        // Main's answer replaces the guess: it trims the URL, so what came back
        // is what is stored and the field must show that rather than what was
        // typed.
        setUrlDraft(null);
        clearTokenField();
        setBusy("idle");
        setSavedNote(
          next.configured
            ? "Saved. This Mac will sync from the next interval it closes."
            : "Saved.",
        );
        config.reload();
        reloadDoctor();
      },
      (e: unknown) => {
        setError(messageOf(e));
        setBusy("idle");
      },
    );
  };

  const flush = (): void => {
    setBusy("flushing");
    setError(null);
    ipc.flush().then(
      (r) => {
        setBusy("idle");
        setSavedNote(
          r.ok
            ? `Sent ${formatCount(r.confirmed)} row${r.confirmed === 1 ? "" : "s"}.`
            : null,
        );
        if (!r.ok) setError(r.error ?? "the flush failed with no reason given");
        reloadDoctor();
        config.reload();
      },
      (e: unknown) => {
        setError(messageOf(e));
        setBusy("idle");
      },
    );
  };

  const openWizard = (): void => {
    void ipc.openCloudSetup().catch((e: unknown) => setError(messageOf(e)));
  };

  const dirty = urlDraft !== null || tokenTyped;
  const vaultMissing = saved !== null && !saved.vaultAvailable;

  return (
    <SettingsCard
      id="sync"
      title="Cloud sync"
      description="A second copy of your hours, and the only way two Macs add up to one week."
      action={
        <Badge data-slot="sync-status" data-tone={health.tone} variant={TONE_VARIANT[health.tone]}>
          {health.label}
        </Badge>
      }
    >
      <p data-slot="sync-note" className="text-xs text-muted-foreground">
        {health.note}
      </p>

      {health.problems.length > 0 ? (
        <AlertBanner variant="error" title="Sync is not getting through" lines={health.problems} />
      ) : null}

      {/* The numbers, always — including in the not-configured state, where
          every timestamp is null and none of them is a problem. Hiding them
          there would make "not set up" and "broken" look like the same screen,
          which is the distinction this card exists to keep. */}
      <div data-slot="sync-health" className="mt-3 rounded-md border border-border bg-muted px-3 py-2">
        <ReadRow
          label="Waiting to upload"
          value={sync === null ? "—" : formatCount(sync.pendingRows)}
        />
        <ReadRow
          label="Last upload"
          value={<Ago ms={sync?.lastFlushOkMs ?? null} nowMs={nowMs} />}
        />
        <ReadRow label="Last download" value={<Ago ms={sync?.lastPullMs ?? null} nowMs={nowMs} />} />
        <ReadRow
          label="Row check"
          value={
            doctor.data?.fingerprint.matched === true
              ? `matched (${formatCount(doctor.data.fingerprint.localCount)})`
              : doctor.data?.fingerprint.matched === false
                ? "MISMATCH"
                : "not checked yet"
          }
          title={
            doctor.data?.fingerprint.checkedAtMs == null
              ? undefined
              : `checked ${new Date(doctor.data.fingerprint.checkedAtMs).toLocaleString()}`
          }
        />
      </div>

      <Separator className="my-4" />

      {/* ── EXACTLY ONE PRIMARY PATH ──────────────────────────────────────── */}
      <div data-slot="sync-primary" data-configured={String(configured)}>
        {configured ? (
          <>
            <p className="text-xs text-muted-foreground">
              Syncing to <code className="rounded bg-muted px-1 py-0.5">{saved?.workerUrl}</code>
              {saved?.tokenPresent === true
                ? " · this Mac’s token is stored in the keychain."
                : "."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={runTest}
                disabled={busy !== "idle" || urlProblem !== null}
              >
                {busy === "testing" ? "Testing…" : "Test connection"}
              </Button>
              <Button size="sm" variant="outline" onClick={flush} disabled={busy !== "idle"}>
                {busy === "flushing" ? "Syncing…" : "Sync now"}
              </Button>
              <Button size="sm" variant="ghost" onClick={openWizard} disabled={busy !== "idle"}>
                Set up again…
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Nothing is sent anywhere yet. Every hour is recorded and kept on this Mac.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Setting this up creates a database and a Worker in your own Cloudflare
              account, on the free plan.
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={openWizard} disabled={busy !== "idle"}>
                Set up cloud sync…
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ── THE EXPERT FIELDS, BEHIND A DISCLOSURE ────────────────────────── */}
      {/* A plain toggle button rather than a native <details>, so the open
          state is ours to hold and can be forced open by the two conditions
          above that mean the FIELDS are the fix rather than the wizard. */}
      <div className="mt-4">
        {manualOpen ? null : (
          <button
            type="button"
            data-slot="manual-toggle"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setOpened(true)}
          >
            {configured
              ? "Change the URL, or replace this Mac’s token"
              : "Already have a Worker URL and token? Enter them by hand"}
          </button>
        )}

        {manualOpen ? (
          <div data-slot="manual-fields" className="flex flex-col gap-3">
            <Field
              htmlFor="sync-url"
              label="Worker URL"
              hint="Set up sync fills this in. It looks like https://wwb-sync.<account>.workers.dev"
              error={urlProblem}
            >
              <input
                id="sync-url"
                type="text"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="https://wwb-sync.example.workers.dev"
                className={inputClass}
                aria-invalid={urlProblem !== null}
                value={url}
                onChange={(e) => {
                  setUrlDraft(e.target.value);
                  setTest(null);
                  setSavedNote(null);
                }}
              />
            </Field>

            <Field
              htmlFor="sync-token"
              label="This Mac’s token"
              hint={
                vaultMissing
                  ? "This Mac has no keychain available, so a token cannot be stored."
                  : saved?.tokenPresent === true
                    ? "A token is stored. It cannot be shown again — type a new one to replace it, or leave this blank."
                    : "Each Mac has its own, minted by setup on that Mac. It is 44 characters and ends in “=”."
              }
            >
              {/* UNCONTROLLED. The value never reaches React state, a re-render
                  closure, or the DOM as an attribute. See the file header. */}
              <input
                id="sync-token"
                ref={tokenRef}
                type="password"
                name="wwb-sync-token"
                spellCheck={false}
                autoComplete="off"
                disabled={vaultMissing}
                placeholder={saved?.tokenPresent === true ? "•••••••• stored" : "paste the token"}
                className={inputClass}
                onChange={(e) => {
                  setTokenTyped(e.target.value.trim() !== "");
                  // The ENUM, never the value. See `shared/credentials.ts`.
                  setTokenShape(classifyCredential(e.target.value));
                  setTest(null);
                  setSavedNote(null);
                }}
              />
            </Field>

            <WrongCredentialNote shape={tokenShape} onSetUp={openWizard} />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={runTest}
                // Nothing to test at all is the one state where this button
                // would be decoration: no stored config and nothing typed.
                disabled={busy !== "idle" || urlProblem !== null || (!dirty && !configured)}
              >
                {busy === "testing" ? "Testing…" : "Test connection"}
              </Button>
              <Button
                size="sm"
                onClick={save}
                disabled={busy !== "idle" || !dirty || urlProblem !== null}
              >
                {busy === "saving" ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {test === null ? null : (
        <p
          data-slot="sync-test-result"
          data-ok={String(test.ok)}
          role="status"
          className={`mt-3 text-xs ${test.ok ? "text-muted-foreground" : "text-destructive"}`}
        >
          {test.ok
            ? `Reached the Worker and the token was accepted${test.ms === null ? "" : ` (${String(test.ms)} ms)`}.`
            : (test.error ?? "The test failed with no reason given.")}
        </p>
      )}
      {error === null ? null : (
        <p data-slot="sync-error" role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
      {savedNote === null ? null : (
        <p data-slot="sync-saved" role="status" className="mt-3 text-xs text-muted-foreground">
          {savedNote}
        </p>
      )}
    </SettingsCard>
  );
}

/**
 * The warning for the OTHER credential pasted into this field.
 *
 * The two are no longer adjacent — the Cloudflare API token is in a different
 * window entirely — so this is a second line of defence rather than the fix.
 * It warns and never blocks; it renders before any request is made; and it
 * never echoes the value.
 */
function WrongCredentialNote({
  shape,
  onSetUp,
}: {
  shape: CredentialShape;
  onSetUp: () => void;
}): React.ReactElement | null {
  if (shape === "cloudflare-api-token") {
    return (
      <div data-slot="wrong-credential" data-shape={shape} className="text-xs text-destructive">
        <p>
          <b>That looks like a Cloudflare API token, not this Mac’s sync token.</b>
        </p>
        <p className="mt-1 text-muted-foreground">
          They are two different credentials. A Cloudflare API token <i>creates</i> the
          cloud; this Mac’s sync token is what the app uses afterwards, and it is 44
          characters ending in “=”.
        </p>
        <p className="mt-1 text-muted-foreground">
          If you have not set the cloud up yet, use <b>Set up cloud sync</b> instead.
        </p>
        <div className="mt-2">
          <Button size="sm" variant="outline" onClick={onSetUp}>
            Set up cloud sync…
          </Button>
        </div>
      </div>
    );
  }
  if (shape === "url") {
    return (
      <p data-slot="wrong-credential" data-shape={shape} className="text-xs text-destructive">
        <b>That is a URL, not a token.</b> The Worker URL goes in the field above; this
        needs the credential itself.
      </p>
    );
  }
  return null;
}

export default SyncSettings;
