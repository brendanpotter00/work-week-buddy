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
import { createHash, randomBytes } from "node:crypto";

import {
  DEFAULT_DATABASE_NAME,
  createCloudflareApi,
  describeCloudError,
  findDatabase,
  probeCloud,
  readEnrolledMachines,
  revokeMachine,
  runCloudSetup,
  type CloudSetupProgress,
  type EnrolledMachineRow,
} from "../cloud";
import type {
  CloudProbeRequest,
  CloudProbeResult,
  CloudRevokeRequest,
  CloudRevokeResult,
  CloudSetupResult,
  CloudSetupRunRequest,
  EnrolledMachine,
} from "../shared/ipc-types";
import type { SyncConfigGateway } from "./bootstrap";
import { log } from "./log";

/**
 * 32 cryptographically random bytes, base64 — 44 characters ending in `=`.
 *
 * The plaintext exists in exactly two places: this Mac's Keychain, and the one
 * screen that shows it if the Keychain refuses. Only its SHA-256 is ever sent
 * anywhere.
 */
export function mintMachineToken(): string {
  return randomBytes(32).toString("base64");
}

/**
 * SHA-256, lowercase hex — the format `machine_token.token_sha256` stores.
 *
 * Lives in `src/main/` and is injected into `src/cloud/`, which imports nothing
 * from `node:` and must keep it that way. The Worker computes the same digest
 * with WebCrypto; a test pins that the two agree, because if they ever stopped
 * agreeing every machine would 401 for ever with nothing in any log.
 */
export function hashMachineToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CloudSetupGateway {
  probe(req: CloudProbeRequest): Promise<CloudProbeResult>;
  run(req: CloudSetupRunRequest): Promise<CloudSetupResult>;
  revoke(req: CloudRevokeRequest): Promise<CloudRevokeResult>;
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

  /** Tag each registry row with whether it is the Mac this window is running on. */
  const withThisMac = (rows: readonly EnrolledMachineRow[]): EnrolledMachine[] =>
    rows.map((m) => ({
      machineId: m.machineId,
      label: m.label,
      enrolledAtMs: m.enrolledAtMs,
      lastSeenMs: m.lastSeenMs,
      isThisMac: m.machineId === deps.machineId,
    }));

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
        scopes: result.scopes === null ? null : { ...result.scopes },
        deployment:
          d === null
            ? null
            : {
                accountId: d.accountId,
                databaseExists: d.databaseExists,
                workerExists: d.workerExists,
                machines: withThisMac(d.machines),
                accountSubdomain: d.accountSubdomain,
                rowsInCloud: d.rowsInCloud,
                zones: d.zones.map((z) => ({ id: z.id, name: z.name })),
                workerDomains: d.workerDomains.map((w) => ({
                  hostname: w.hostname,
                  service: w.service,
                })),
              },
        error: result.error,
      };
    },

    async revoke(req) {
      // Resolve the database by name rather than trusting a renderer-supplied
      // id: the wizard is the only caller, and this keeps "which database" a
      // fact main establishes rather than an argument it is handed.
      const cf = api(req.apiToken);
      try {
        const database = findDatabase(
          await cf.listDatabases(req.accountId),
          DEFAULT_DATABASE_NAME,
        );
        if (database === null) {
          return {
            ok: false,
            machines: [],
            error: `there is no “${DEFAULT_DATABASE_NAME}” database on this account to revoke against.`,
          };
        }
        if (req.machineId === deps.machineId) {
          // Revoking the Mac you are standing on is what "Set up again" does,
          // correctly and in the right order. Doing it here would take this Mac
          // offline with no replacement token.
          return {
            ok: false,
            machines: withThisMac(
              await readEnrolledMachines(cf, req.accountId, database.uuid),
            ),
            error:
              "that is this Mac. Run setup again instead — it mints a new token " +
              "for this Mac and retires the old one in the right order.",
          };
        }
        await revokeMachine({
          api: cf,
          accountId: req.accountId,
          databaseId: database.uuid,
          machineId: req.machineId,
        });
        log.info("cloud setup revoked a machine's token");
        return {
          ok: true,
          machines: withThisMac(
            await readEnrolledMachines(cf, req.accountId, database.uuid),
          ),
          error: null,
        };
      } catch (err) {
        // Never throws at the renderer: the caller is a button, and a rejected
        // invoke renders as a stack trace.
        return { ok: false, machines: [], error: describeCloudError(err) };
      }
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
          hashToken: hashMachineToken,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          onProgress: emit,
          commit: async ({ workerUrl, token }) => {
            await deps.syncConfig.write({ workerUrl, token });
          },
        },
        {
          accountId: req.accountId,
          ...(req.subdomain === undefined ? {} : { subdomain: req.subdomain }),
          ...(req.customDomain === undefined ? {} : { customDomain: req.customDomain }),
        },
      );

      // The URL is not a credential and is worth having in the log; the token
      // is, and is not in `outcome.steps` — every detail string is written by
      // `bringup.ts` from names and counts.
      log.info(
        `cloud setup ${outcome.ok ? "succeeded" : "did not finish"} ` +
          `(url ${outcome.workerUrl ?? "none"}, also ${outcome.altWorkerUrl ?? "none"})` +
          (outcome.error === null ? "" : `: ${describeCloudError(outcome.error)}`),
      );

      return {
        steps: outcome.steps.map((s) => ({ ...s })),
        done: outcome.done,
        error: outcome.error,
        ok: outcome.ok,
        workerUrl: outcome.workerUrl,
        altWorkerUrl: outcome.altWorkerUrl,
        addresses: outcome.addresses.map((a) => ({ ...a })),
        unstoredToken: outcome.unstoredToken,
      };
    },
  };
}
