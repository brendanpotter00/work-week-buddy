/**
 * The wire between `src/cloud/` and the running app.
 *
 * `src/cloud/` knows the Cloudflare API and nothing about Electron. This file
 * is the three things it deliberately does not own: where this Mac's UUID comes
 * from, where randomness comes from, and what "turn sync on" means locally.
 *
 * ── THE CLOUDFLARE API TOKEN IS BORROWED, NEVER KEPT ────────────────────────
 * It arrives as an argument, is handed to one `CloudflareApi` object, and both
 * are unreachable the moment the call resolves. It is never written to
 * `settings.json`, never encrypted into the keychain beside the sync token,
 * never logged, and never returned — `CloudProbeResult` and `CloudSetupResult`
 * have no field that could carry one back.
 *
 * That is a deliberate choice against convenience. Persisting it would let the
 * wizard skip the paste on a re-run, and it would also mean this app held, at
 * rest, a credential that can create and delete resources on a real billable
 * Cloudflare account — a far larger blast radius than the Worker token, which
 * can only append rows to one table. `test/cloud/secrecy.test.ts` asserts the
 * token reaches no file, no log and no doctor report.
 *
 * ── NOTHING HERE RUNS ON THE BOOT PATH ──────────────────────────────────────
 * Every function below is invoked from a button. None of it is called during
 * `createCoreServices`, none of it touches the keychain until the very last
 * step, and every network call is awaited off the main thread's critical path.
 * `src/main/file-access.ts` records what happens when that rule is broken.
 */
import { randomBytes } from "node:crypto";

import {
  createCloudflareApi,
  describeCloudError,
  otherTokenPresent,
  probeCloud,
  runCloudSetup,
  type CloudSetupProgress,
} from "../cloud";
import type {
  CloudProbeRequest,
  CloudProbeResult,
  CloudSetupResult,
  CloudSetupRunRequest,
} from "../shared/ipc-types";
import type { SyncConfigGateway } from "./bootstrap";
import { log } from "./log";

/**
 * 32 cryptographically random bytes, base64 — the same shape and the same
 * entropy as `openssl rand -base64 32` in `scripts/bringup-cloud.sh`, so a
 * token minted here and one minted there are indistinguishable.
 */
export function mintMachineToken(): string {
  return randomBytes(32).toString("base64");
}

export interface CloudSetupGateway {
  probe(req: CloudProbeRequest): Promise<CloudProbeResult>;
  run(req: CloudSetupRunRequest): Promise<CloudSetupResult>;
}

export interface CloudSetupDeps {
  /** This Mac's IOPlatformUUID. "" when `ioreg` could not be read. */
  readonly machineId: string;
  /**
   * Reused rather than reimplemented: `write()` already puts the URL in
   * `settings.json`, the token through `safeStorage`, and calls
   * `sync.reconfigure()` so the flusher picks it up with no relaunch. Setup
   * finishing is exactly the same event as somebody pasting both by hand.
   */
  readonly syncConfig: Pick<SyncConfigGateway, "write">;
  readonly onProgress?: (p: CloudSetupProgress) => void;
  /** Injected by the tests, which route every request into a fake Cloudflare. */
  readonly fetchImpl?: typeof fetch;
  readonly mintToken?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly apiBaseUrl?: string;
}

export function createCloudSetupGateway(deps: CloudSetupDeps): CloudSetupGateway {
  const api = (apiToken: string) =>
    createCloudflareApi({
      apiToken,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.apiBaseUrl === undefined ? {} : { baseUrl: deps.apiBaseUrl }),
    });

  return {
    async probe(req) {
      const result = await probeCloud(
        { api: api(req.apiToken), thisMachineId: deps.machineId },
        req.accountId,
      );
      const d = result.deployment;
      return {
        tokenValid: result.tokenValid,
        tokenStatus: result.tokenStatus,
        accounts: result.accounts.map((a) => ({ id: a.id, name: a.name })),
        deployment:
          d === null
            ? null
            : {
                accountId: d.accountId,
                databaseExists: d.databaseExists,
                workerExists: d.workerExists,
                verdict: d.verdict,
                // Both slots, so the pane stays accurate while the owner is
                // still choosing one. Names only — `bindingNames` never
                // carries a value, and this reduces it further to two booleans.
                slotsWithToken: (["personal", "work"] as const).filter((slot) =>
                  // `otherTokenPresent` answers "does the OTHER slot have one",
                  // so asking it about the other slot answers it about this one.
                  otherTokenPresent(d.bindingNames, slot === "personal" ? "work" : "personal"),
                ),
                accountSubdomain: d.accountSubdomain,
                rowsInCloud: d.rowsInCloud,
              },
        error: result.error,
      };
    },

    async run(req) {
      // A step-by-step line in `wwb.log`, so a run that failed can be diagnosed
      // afterwards without a screenshot. `describeCloudError` has already been
      // through `redactSecrets`, and no detail string is ever built from a
      // token, but the redaction is applied again here on the way to disk
      // because this is the one place in the feature that writes a file.
      const emit = (p: CloudSetupProgress): void => {
        deps.onProgress?.(p);
      };
      const outcome = await runCloudSetup(
        {
          api: api(req.apiToken),
          thisMachineId: deps.machineId,
          mintToken: deps.mintToken ?? mintMachineToken,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          onProgress: emit,
          commit: async ({ workerUrl, token }) => {
            await deps.syncConfig.write({ workerUrl, token });
          },
        },
        {
          accountId: req.accountId,
          slot: req.slot,
          ...(req.rotateOtherToken === undefined
            ? {}
            : { rotateOtherToken: req.rotateOtherToken }),
          ...(req.subdomain === undefined ? {} : { subdomain: req.subdomain }),
        },
      );

      // The URL is not a credential and is worth having in the log; the tokens
      // are, and are not in `outcome.steps` — every detail string is written by
      // `bringup.ts` from names and counts.
      log.info(
        `cloud setup ${outcome.ok ? "succeeded" : "did not finish"} ` +
          `(slot ${outcome.slot}, url ${outcome.workerUrl ?? "none"})` +
          (outcome.error === null ? "" : `: ${describeCloudError(outcome.error)}`),
      );

      return {
        steps: outcome.steps.map((s) => ({ ...s })),
        done: outcome.done,
        error: outcome.error,
        ok: outcome.ok,
        workerUrl: outcome.workerUrl,
        slot: outcome.slot,
        otherSlot: outcome.otherSlot,
        otherMachineToken: outcome.otherMachineToken,
        unstoredToken: outcome.unstoredToken,
      };
    },
  };
}
