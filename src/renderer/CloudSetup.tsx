/**
 * The cloud-setup wizard — the fourth window.
 *
 * ── WHY A WINDOW ────────────────────────────────────────────────────────────
 * It used to be a bordered sub-panel inside the Cloud sync card, underneath two
 * fields that only make sense for a setup that already exists. The owner's words
 * were "this onboarding flow is very confusing … I don't like how there was like
 * a sub menu", and he was right: the thing that CREATES a setup was three levels
 * down, below the expert affordance.
 *
 * A window because the wizard is a TASK, not a setting. It has its own steps,
 * its own progress list, its own error surface, and a natural "close = cancel".
 * It also has room for the wayfinding screen that fixes "I was looking for
 * Create Token on the Worker's page", which is exactly what a 680-px card could
 * not give it. And the TRAY can open it directly — a setup flow reachable only
 * by finding Settings and scrolling to a card is a setup flow that does not get
 * run.
 *
 * NOT folded into first-run onboarding, deliberately. That window is a fixed
 * 560 × 640 `resizable: false` box whose contents `npm run smoke` measures with
 * a hard 16 px headroom requirement — an earlier draft overflowed it by 3 px by
 * adding one line. Independently: cloud sync is optional. The local mirror is
 * the product and the cloud is a second copy, so demanding a Cloudflare account
 * before the app has proved itself is the wrong trade. Nothing opens this
 * window on first run.
 *
 * ── THE API TOKEN NEVER ENTERS REACT STATE ──────────────────────────────────
 * Held in a `useRef` holding the STRING, not a DOM ref: this is a multi-step
 * wizard, so the input is unmounted by the time the run needs the value and a
 * DOM ref would be `null` exactly then. (Not hypothetical — it is the first
 * thing `test/renderer/cloud-setup.test.tsx` caught.) A ref does not participate
 * in rendering, so the secret is in no re-render closure, is never written to
 * the DOM as an attribute, and is never rendered. React state holds a BOOLEAN.
 */
import * as React from "react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { AccountStep } from "@/renderer/components/cloud-setup/account-step";
import { DoneStep } from "@/renderer/components/cloud-setup/done-step";
import { IntroStep } from "@/renderer/components/cloud-setup/intro-step";
import { hostnameLabelError, zoneNameError } from "@/cloud/api";
import { ReviewStep, type AddressChoice } from "@/renderer/components/cloud-setup/review-step";
import { StepList } from "@/renderer/components/cloud-setup/step-list";
import { TokenStep } from "@/renderer/components/cloud-setup/token-step";
import { TitleBar } from "@/renderer/components/title-bar";
import { TOKEN_PAGE_URL, tokenCreateUrl } from "@/cloud/token-url";
import {
  ipc,
  messageOf,
  useAppInfo,
  useCloudSetupProgress,
  useSyncConfig,
} from "@/renderer/lib/ipc";
import { useThemeMirror } from "@/renderer/lib/use-theme-mirror";
import type {
  CloudCustomDomainRequest,
  CloudDeployment,
  CloudProbeResult,
  CloudSetupResult,
} from "@/shared/ipc-types";

type Phase = "intro" | "token" | "account" | "review" | "running" | "done";

export function CloudSetup(): React.ReactElement {
  useThemeMirror();

  const info = useAppInfo();
  const config = useSyncConfig();

  // A returning owner entering through "Set up again…" starts at the token
  // screen; only someone with nothing configured needs the explanation. Decided
  // once, when the config first arrives, so it cannot flip mid-wizard.
  const [phase, setPhase] = React.useState<Phase | null>(null);
  React.useEffect(() => {
    setPhase((p) => (p === null && config.data !== null ? (config.data.configured ? "token" : "intro") : p));
  }, [config.data]);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<CloudProbeResult | null>(null);
  const [accountId, setAccountId] = React.useState("");
  const [subdomain, setSubdomain] = React.useState("");
  /**
   * The optional second address.
   *
   * Ticked by default only when there is a domain to prefill — a ticked box
   * over an empty field is a decision the owner did not make. Settled once,
   * from the probe, so typing into it is never fought by a re-render.
   */
  const [address, setAddress] = React.useState<AddressChoice>({
    enabled: false,
    label: "wwb",
    zoneId: "",
    zoneName: "",
  });
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [machines, setMachines] = React.useState<CloudDeployment["machines"] | null>(null);
  const [result, setResult] = React.useState<CloudSetupResult | null>(null);
  const [progress, setProgress] = useCloudSetupProgress();

  /** THE SECRET LIVES HERE AND NOWHERE ELSE. See the header. */
  const tokenRef = React.useRef("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [tokenTyped, setTokenTyped] = React.useState(false);

  const readToken = (): string => tokenRef.current.trim();

  /**
   * Drop the credential, then close the window.
   *
   * In that order, and the order is the point: the API token must not outlive
   * the wizard even by the tick it takes the window to go away. `window.close()`
   * rather than a new IPC channel — a top-level renderer closing its own
   * BrowserWindow needs no permission and no round trip, and "close = cancel"
   * is what the window's own red button already does.
   */
  const finish = (): void => {
    tokenRef.current = "";
    if (inputRef.current) inputRef.current.value = "";
    setTokenTyped(false);
    try {
      globalThis.close();
    } catch {
      /* no window to close — a test harness, or already gone */
    }
  };

  const openTokenPage = (): void => {
    void ipc.openTokenPage().catch((e: unknown) => setError(messageOf(e)));
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
          // A scope problem or a rejected token is rendered BY the token screen
          // as a named permission, not as a red banner — that wording is the
          // whole fix for the failure that cost an evening.
          if (!r.tokenValid || r.scopes?.d1 === "missing" || r.scopes?.workers === "missing") {
            setPhase("token");
            return;
          }
          if (r.error !== null) {
            setError(r.error);
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
          setMachines(r.deployment.machines);
          setPhase("review");
        },
        (e: unknown) => {
          setBusy(false);
          setError(messageOf(e));
        },
      );
  };

  const revoke = (machineId: string | null, confirm: boolean): void => {
    if (!confirm) {
      setRevoking(machineId);
      return;
    }
    if (machineId === null) return;
    setBusy(true);
    setError(null);
    ipc.revokeMachine({ apiToken: readToken(), accountId, machineId }).then(
      (r) => {
        setBusy(false);
        setRevoking(null);
        setMachines(r.machines);
        if (!r.ok) setError(r.error ?? "the revoke failed with no reason given");
      },
      (e: unknown) => {
        setBusy(false);
        setRevoking(null);
        setError(messageOf(e));
      },
    );
  };

  /**
   * Prefill the address from whatever the probe found, exactly once per probe.
   *
   * `enabled` follows the DATA: a domain to offer means the box starts ticked,
   * and no domain to offer means it starts unticked, because there is nothing to
   * prefill and a ticked box over an empty field is not a default, it is a trap.
   */
  React.useEffect(() => {
    const zones = probe?.deployment?.zones ?? [];
    const first = [...zones].sort((a, b) => a.name.localeCompare(b.name))[0];
    setAddress((a) =>
      a.zoneName === "" && first !== undefined
        ? { ...a, enabled: true, zoneId: first.id, zoneName: first.name }
        : a,
    );
  }, [probe]);

  const run = (): void => {
    const apiToken = readToken();
    if (apiToken === "" || accountId === "") return;
    const customDomain = customDomainRequest(address);
    setBusy(true);
    setError(null);
    setProgress(null);
    setPhase("running");
    ipc
      .runCloudSetup({
        apiToken,
        accountId,
        ...(subdomain.trim() === "" ? {} : { subdomain: subdomain.trim() }),
        // Sent only when the box is ticked AND what is in it is usable. An
        // address the owner cannot have is not a reason to refuse to run —
        // `Set it up` is never disabled by anything in that section — so a bad
        // one is simply not sent and setup goes ahead on workers.dev alone.
        ...(customDomain === null ? {} : { customDomain }),
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
        },
        (e: unknown) => {
          setBusy(false);
          setError(messageOf(e));
          setPhase("review");
        },
      );
  };

  const deployment: CloudDeployment | null =
    probe?.deployment == null
      ? null
      : { ...probe.deployment, machines: machines ?? probe.deployment.machines };

  return (
    <div data-view="cloud-setup" className="flex h-svh flex-col bg-background">
      <TitleBar window="cloudSetup" className="px-7 pb-3">
        <h1 className="font-heading text-[19px] leading-tight font-semibold tracking-tight">
          Cloud sync
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing is created until you say so. Closing this window cancels.
        </p>
      </TitleBar>

      {/* THIS scrolls, never the page body — the same rule the other three
          windows follow. */}
      <div
        data-slot="cloud-setup"
        data-phase={phase ?? "loading"}
        className="min-h-0 flex-1 overflow-y-auto px-7 pb-6"
      >
        {error === null ? null : (
          <div className="mb-4">
            <AlertBanner variant="error" title="Setup could not continue" lines={[error]} />
          </div>
        )}

        {phase === "intro" ? (
          <IntroStep onNext={() => setPhase("token")} onCancel={finish} />
        ) : null}

        {phase === "token" ? (
          <TokenStep
            inputRef={inputRef}
            tokenTyped={tokenTyped}
            busy={busy}
            probe={probe}
            deepLinkAvailable={tokenCreateUrl() !== TOKEN_PAGE_URL}
            onType={(value) => {
              tokenRef.current = value;
              setTokenTyped(value.trim() !== "");
              setError(null);
              // A fresh paste invalidates the last verdict, or the screen would
              // keep showing a permission problem for a token nobody has
              // checked yet.
              setProbe(null);
            }}
            onOpenTokenPage={openTokenPage}
            onNext={() => runProbe()}
            onCancel={finish}
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

        {phase === "review" && deployment !== null ? (
          <ReviewStep
            deployment={deployment}
            zonesScope={probe?.scopes?.zones ?? "unknown"}
            machineLabel={info.data?.machineLabel ?? "This Mac"}
            subdomain={subdomain}
            address={address}
            busy={busy}
            revoking={revoking}
            onSubdomain={setSubdomain}
            onAddress={setAddress}
            onRevoke={revoke}
            onRun={run}
            onCancel={finish}
          />
        ) : null}

        {phase === "running" || phase === "done" ? (
          <div className="flex flex-col gap-4">
            <StepList steps={result?.steps ?? progress?.steps ?? []} />
            {phase === "done" && result !== null ? (
              <DoneStep result={result} onClose={finish} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The address, as the run request wants it — or null when there is nothing to
 * send.
 *
 * Null covers both "not ticked" and "ticked but not usable", and both mean the
 * same thing to `run()`: send nothing and let setup do the workers.dev address
 * alone. A `zoneId` is included only when it came from the PICKER; a typed
 * domain sends `zone_name` instead, which is what makes `Zone · Read` optional.
 */
function customDomainRequest(a: AddressChoice): CloudCustomDomainRequest | null {
  const label = a.label.trim().toLowerCase();
  const zoneName = a.zoneName.trim().toLowerCase();
  if (!a.enabled) return null;
  if (hostnameLabelError(label) !== null || zoneNameError(zoneName) !== null) return null;
  return a.zoneId === ""
    ? { label, zone: { name: zoneName } }
    : { label, zone: { id: a.zoneId, name: zoneName } };
}

export default CloudSetup;
