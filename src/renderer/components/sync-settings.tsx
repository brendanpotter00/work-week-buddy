/**
 * Turning cloud sync on — the thing that could not be done at all.
 *
 * Every layer under this existed and was tested: the Worker, the flusher, the
 * puller, the `safeStorage` vault, and the `wwb:sync:config` /
 * `wwb:sync:setConfig` channels. Nothing in the renderer ever called them, so
 * `npm run bringup:cloud` could print a URL and a token and there was nowhere
 * to put them. `devTools: isDev()` closed the console workaround in a packaged
 * build, which left exactly zero routes in. A feature that is built, tested and
 * unreachable is not shipped.
 *
 * ── THE TOKEN NEVER ENTERS REACT STATE ──────────────────────────────────────
 *
 * The token input is UNCONTROLLED, held by a ref, and that is a security
 * decision rather than a style one. A controlled `value={token}` would put the
 * secret in a React fibre, in every re-render's closure, in a component-tree
 * snapshot and — depending on the renderer — in a `value` attribute in the DOM.
 * With a ref it exists in exactly one DOM node's `.value` property and in the
 * argument to one IPC call, and the field is cleared the moment that call
 * resolves. What React state holds is a BOOLEAN: whether something has been
 * typed. `test/renderer/settings.test.tsx` asserts the token is absent from
 * `innerHTML`, from every attribute, and from the state the pane renders back.
 *
 * The other direction is enforced by the contract itself: `SyncConfigState` has
 * `tokenPresent: boolean` and no field a token could ride back on, so there is
 * nothing here to accidentally render.
 *
 * ── WHY "TEST" IS A SEPARATE BUTTON ─────────────────────────────────────────
 *
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

  // `null` means "not edited", which is not the same as an empty edit — the
  // same rule `device-name.tsx` uses. It is what lets the field adopt the stored
  // URL when the snapshot arrives without stamping over something half-typed.
  const [urlDraft, setUrlDraft] = React.useState<string | null>(null);
  const url = urlDraft ?? saved?.workerUrl ?? "";
  const urlProblem = urlDraft === null ? null : workerUrlError(urlDraft);

  // The secret lives HERE and nowhere else. See the header.
  const tokenRef = React.useRef<HTMLInputElement>(null);
  const [tokenTyped, setTokenTyped] = React.useState(false);

  const [busy, setBusy] = React.useState<Busy>("idle");
  const [test, setTest] = React.useState<SyncTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);
  const nowMs = Date.now();

  const { reload: reloadDoctor } = doctor;

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

      <div className="flex flex-col gap-3">
        <Field
          htmlFor="sync-url"
          label="Worker URL"
          hint="From npm run bringup:cloud — https://wwb-sync.<account>.workers.dev"
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
                : "Each Mac gets its own token. Swapping them attributes every hour to the other laptop."
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
              setTest(null);
              setSavedNote(null);
            }}
          />
        </Field>
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={runTest}
          // Nothing to test at all is the one state where this button would be
          // decoration: no stored config and nothing typed.
          disabled={busy !== "idle" || urlProblem !== null || (!dirty && !saved?.configured)}
        >
          {busy === "testing" ? "Testing…" : "Test connection"}
        </Button>
        <Button size="sm" onClick={save} disabled={busy !== "idle" || !dirty || urlProblem !== null}>
          {busy === "saving" ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={flush}
          disabled={busy !== "idle" || saved?.configured !== true}
          title={
            saved?.configured === true
              ? undefined
              : "There is nowhere to send anything until this is set up."
          }
        >
          {busy === "flushing" ? "Syncing…" : "Sync now"}
        </Button>
      </div>
    </SettingsCard>
  );
}

export default SyncSettings;
