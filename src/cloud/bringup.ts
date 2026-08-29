/**
 * Setting the cloud half up, from inside the app.
 *
 * Create or ADOPT the D1 database, apply the schema, ENROL THIS MAC, deploy the
 * Worker, and turn sync on here — over the Cloudflare REST API, which means no
 * terminal, no `wrangler login`, and no Node toolchain on a Mac that only ever
 * wanted to know how many hours it worked.
 *
 * ── THIS MAC ENROLS ITSELF, AND ONLY ITSELF ─────────────────────────────────
 * There are no slots and nothing to carry between machines. Each install mints
 * its own token, writes the SHA-256 of it next to its own IOPlatformUUID in the
 * `machine_token` table, and keeps the plaintext in its own Keychain. A machine
 * can only ever enrol its own id, and only from the machine itself, so the
 * failure the old slot detection existed to prevent — both Macs syncing, every
 * total right, every hour filed under the wrong laptop for ever — is not merely
 * detected, it is unconstructible.
 *
 * Enrolment and revocation go over the D1 REST query endpoint rather than a
 * Worker route. A `POST /enrol` route would let any valid token mint itself a
 * second identity, and a `POST /revoke` would let a stolen token take every
 * other Mac offline. Both instead need the Cloudflare API token — the
 * credential that can already destroy the whole database.
 *
 * ── RE-RUNNING MUST BE FREE ─────────────────────────────────────────────────
 * Every step below is idempotent, and that is the design constraint rather than
 * a nicety: a wizard that fails at step six and makes you start over has
 * already created a database, and the second attempt must find it rather than
 * make a second one. So:
 *
 *   database   adopted by name if it exists. Creating a duplicate is a failure,
 *              not a fallback — two `wwb` databases means half your history is
 *              in the one nothing is pointed at.
 *   schema     CREATE TABLE IF NOT EXISTS throughout. Free to reapply.
 *   enrol      a new row for THIS machine; older rows for this machine only are
 *              revoked afterwards. Never touches another machine's row.
 *   deploy     an upload replaces the script. There is nothing left to lose:
 *              the Worker's only binding is DB.
 *   subdomain  claimed only when the account has none.
 *   save       the local half is written LAST, once the deployed Worker has
 *              answered on the URL with the token — never on the strength of a
 *              200 from the upload.
 *
 * ── NOTHING HERE BLOCKS, LOGS, OR PERSISTS THE API TOKEN ────────────────────
 * Every step is async I/O and reports progress as it goes, so the window
 * repaints throughout. The Cloudflare API token lives in the `CloudflareApi`
 * object this module is handed and is never written down: not to
 * `settings.json`, not to the keychain, not to `wwb.log`, and not into any
 * string that reaches a screen — `errors.ts` redacts as a backstop.
 *
 * ── THE MINTED SYNC TOKEN NEVER LEAVES THIS MAC ─────────────────────────────
 * Only its SHA-256 is sent to Cloudflare. A dump of the D1 database therefore
 * hands over nothing that can be presented as a credential, and Cloudflare
 * stops holding a live credential it never needed.
 */
import {
  customDomainUrl,
  hostnameLabelError,
  workersDevUrl,
  zoneNameError,
  type CloudScopes,
  type CloudflareApi,
  type D1DatabaseSummary,
  type WorkerBinding,
} from "./api";
import {
  describeCloudError,
  describeFetchFailure,
  isConflictingDnsRecord,
  isTlsNotReady,
} from "./errors";
import {
  WORKER_BUNDLE,
  WORKER_COMPATIBILITY_DATE,
  WORKER_MAIN_MODULE,
  WORKER_NAME,
  WORKER_SCHEMA_SQL,
} from "./worker-bundle.generated";

export const DEFAULT_DATABASE_NAME = "wwb";
export const DEFAULT_WORKER_NAME = WORKER_NAME;

/** The D1 binding the Worker reads its database through (`worker/src/types.ts`). */
const DB_BINDING = "DB";

export type CloudStepId =
  | "token"
  | "account"
  | "database"
  | "schema"
  | "enrol"
  | "deploy"
  | "url"
  | "verify"
  | "save";

export const STEP_LABEL: Record<CloudStepId, string> = {
  token: "Check the API token",
  account: "Find the Cloudflare account",
  database: "Create or adopt the database",
  schema: "Apply the schema",
  enrol: "Enrol this Mac",
  deploy: "Deploy the Worker",
  url: "Turn on the addresses",
  verify: "Check they answer",
  save: "Turn on sync here",
};

export const STEP_ORDER: readonly CloudStepId[] = [
  "token",
  "account",
  "database",
  "schema",
  "enrol",
  "deploy",
  "url",
  "verify",
  "save",
];

/**
 * The two shapes enrolment is allowed to send, checked before anything is bound.
 *
 * A bind is not a licence to send junk. Nothing else — not a label, not a
 * device name, no free text of any kind — ever appears in enrolment SQL; a
 * machine's name lives on the `machine` table and gets there via the heartbeat.
 */
const HEX64 = /^[0-9a-f]{64}$/;
/** An IOPlatformUUID, or `bootstrap.ts`'s persisted `randomUUID()` fallback. */
const MACHINE_ID = /^[0-9A-Za-z-]{1,64}$/;

export type StepState = "pending" | "running" | "done" | "failed";

export interface CloudStep {
  readonly id: CloudStepId;
  readonly label: string;
  readonly state: StepState;
  /** One short line. Never a token, never a raw response body. */
  readonly detail: string | null;
}

/** A COMPLETE snapshot, the way every push in this app is. Never a delta. */
export interface CloudSetupProgress {
  readonly steps: readonly CloudStep[];
  readonly done: boolean;
  readonly error: string | null;
}

/**
 * The optional second address, as the review screen collected it.
 *
 * A label and a zone rather than a full hostname, on purpose: a typo in a
 * free-text hostname becomes a DNS failure minutes later with an unhelpful
 * error, and this shape makes that state unrepresentable.
 */
export interface CustomDomainRequest {
  /** One DNS label, e.g. `wwb`. Never a full hostname. */
  readonly label: string;
  /**
   * The zone — by id when setup could list them, by name when it could not.
   *
   * The by-name form is what makes `Zone: Read` optional: the attach carries
   * `zone_name` instead of `zone_id` and needs no zone permission at all.
   */
  readonly zone: { readonly id: string; readonly name: string } | { readonly name: string };
}

/** One address, and what happened when THIS Mac asked it for `/health`. */
export interface AddressProbe {
  readonly url: string;
  readonly kind: "workers.dev" | "custom";
  /** Did this Mac get a usable answer out of it? */
  readonly reachable: boolean;
  /** Null when reachable. Plain words, out of `describeFetchFailure`. */
  readonly error: string | null;
  readonly ms: number | null;
}

export interface CloudSetupOutcome extends CloudSetupProgress {
  readonly ok: boolean;
  readonly workerUrl: string | null;
  /**
   * EVERY address setup turned on, and what each one did from this Mac.
   *
   * The whole diagnostic, and the reason this feature is worth having even if
   * the premise behind it turns out to be wrong. "workers.dev does not resolve
   * from this Mac" and "the custom domain answered in 180 ms" are two different
   * worlds, and before this the app could not tell them apart or say either.
   *
   * Present on FAILURE too — a failed run is exactly when the report is worth
   * most.
   */
  readonly addresses: readonly AddressProbe[];
  /**
   * The other address that is live in Cloudflare and is not the one being used.
   *
   * Diagnostics and a one-click switch in Settings. Never used to sync.
   */
  readonly altWorkerUrl: string | null;
  /**
   * This Mac's token — set ONLY when it could not be stored locally, which on
   * macOS means the keychain refused. Then the owner can paste it into the
   * Cloud sync form by hand rather than being told setup half-worked.
   *
   * The ONLY token this app ever renders. Nothing is ever minted for any other
   * machine, so there is nothing to carry anywhere.
   */
  readonly unstoredToken: string | null;
}

/** One machine already in the registry. */
export interface EnrolledMachineRow {
  readonly machineId: string;
  /** Null until that Mac's first heartbeat reaches the cloud. */
  readonly label: string | null;
  readonly enrolledAtMs: number;
  readonly lastSeenMs: number | null;
}

/** What is out there, before anything is changed. */
export interface CloudProbe {
  readonly tokenValid: boolean;
  readonly tokenStatus: string;
  /** Empty when the token may not enumerate accounts — then ask for the id. */
  readonly accounts: ReadonlyArray<{ id: string; name: string }>;
  /** Null until an account has been chosen. See `CloudScopes`. */
  readonly scopes: CloudScopes | null;
  readonly deployment: CloudDeploymentState | null;
  readonly error: string | null;
}

export interface CloudDeploymentState {
  readonly accountId: string;
  readonly databaseExists: boolean;
  readonly workerExists: boolean;
  /** Machines already in the registry. Empty before the first enrolment. */
  readonly machines: readonly EnrolledMachineRow[];
  /**
   * The account's workers.dev subdomain, or null when it has never claimed one.
   *
   * Null is a question for the owner, not a default to invent: the subdomain is
   * account-wide, appears in the URL of everything they will ever deploy, and
   * Cloudflare treats claiming it as a one-off.
   */
  readonly accountSubdomain: string | null;
  /** Intervals already in this database. Null when there is no database yet. */
  readonly rowsInCloud: number | null;
  /**
   * The domains on this account, for the address picker.
   *
   * EMPTY MEANS TWO DIFFERENT THINGS and `scopes.zones` is what separates them:
   * `ok` with an empty list is an account with no domains on it, and `missing`
   * is a token that may not look. The screen says something different for each.
   */
  readonly zones: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Hostnames already pointed at a Worker on this account, and which one.
   *
   * So the review screen can refuse a name that belongs to something else
   * before anything is created, rather than after a deploy.
   */
  readonly workerDomains: ReadonlyArray<{ hostname: string; service: string }>;
}

export interface BringupDeps {
  readonly api: CloudflareApi;
  /** This Mac's IOPlatformUUID. "" when `ioreg` could not be read. */
  readonly thisMachineId: string;
  /** 32 cryptographically random bytes, base64 — `randomBytes(32)` in main. */
  readonly mintToken: () => string;
  /**
   * SHA-256 of a token, lowercase hex — the format `machine_token` stores.
   *
   * Injected rather than computed here so `src/cloud/` keeps its zero `node:`
   * imports. Main supplies `node:crypto`; the Worker verifies with WebCrypto.
   * Those two agreeing is pinned by a test, because if they ever disagreed
   * every machine would 401 for ever with nothing in any log.
   */
  readonly hashToken: (token: string) => string;
  /** Epoch ms. Injected so a test can assert what was written. */
  readonly now?: () => number;
  /**
   * Persist this Mac's token through `safeStorage` and set `syncWorkerUrl`, so
   * sync is live with no relaunch. Throws when there is no keychain, which is
   * the one failure the outcome answers by showing the token instead.
   */
  readonly commit: (c: {
    workerUrl: string;
    /** The other address setup turned on. Diagnostics only; never used to sync. */
    altWorkerUrl: string | null;
    token: string;
  }) => Promise<void>;
  /** Plain fetch against the deployed Worker. Injected by the tests. */
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (p: CloudSetupProgress) => void;
  /** Injected by the tests so the TLS wait is not a real wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly databaseName?: string;
  readonly workerName?: string;
}

export interface CloudSetupRequest {
  readonly accountId: string;
  /**
   * A workers.dev subdomain to claim, used ONLY when the account has none.
   *
   * Ignored when one already exists — this never renames an account's
   * subdomain, and the probe reports `accountSubdomain` so the screen knows
   * whether to ask at all.
   */
  readonly subdomain?: string;
  /**
   * Also put the Worker on a domain the owner already has on this account.
   *
   * ADDITIVE. The workers.dev address is turned on either way and is never
   * switched off — both hostnames reach the same script, the same D1 and the
   * same `machine_token` registry, and the Worker stamps `machine_id` from the
   * credential rather than from the host. Which hostname a request arrives on
   * is invisible to correctness, and that property is what makes keeping the
   * fallback free rather than awkward.
   *
   * Every failure in this half is a sentence, never a failed setup.
   */
  readonly customDomain?: CustomDomainRequest;
}

/**
 * Look, change nothing.
 *
 * Runs before the wizard offers to do anything, so the screen that asks for
 * confirmation can say what already exists rather than what it intends. It is
 * entirely read-only: a probe that created something would make "cancel" a lie.
 *
 * It is also the SCOPE PREFLIGHT. A missing permission is caught here, before
 * anything is created, and arrives as structured data the screen can render
 * properly — not as a red banner using the words for a different failure. That
 * is the fast path; Rule A in `errors.ts` is the safety net for anything that
 * slips through.
 */
export async function probeCloud(
  deps: Pick<BringupDeps, "api" | "thisMachineId" | "databaseName" | "workerName">,
  accountId?: string,
): Promise<CloudProbe> {
  const dbName = deps.databaseName ?? DEFAULT_DATABASE_NAME;
  const workerName = deps.workerName ?? DEFAULT_WORKER_NAME;

  let tokenStatus: string;
  try {
    tokenStatus = (await deps.api.verifyToken()).status;
  } catch (err) {
    return {
      tokenValid: false,
      tokenStatus: "unknown",
      accounts: [],
      scopes: null,
      deployment: null,
      error: describeCloudError(err),
    };
  }
  if (tokenStatus !== "active") {
    return {
      tokenValid: false,
      tokenStatus,
      accounts: [],
      scopes: null,
      deployment: null,
      // A token can verify with a 200 and still be unusable. Saying which of
      // the two it is saves a round of "but it says the token is fine".
      error: `Cloudflare says this token is “${tokenStatus}”, not active. Create a new one.`,
    };
  }

  let accounts: ReadonlyArray<{ id: string; name: string }> = [];
  try {
    accounts = await deps.api.listAccounts();
  } catch (err) {
    return {
      tokenValid: true,
      tokenStatus,
      accounts: [],
      scopes: null,
      deployment: null,
      error: describeCloudError(err),
    };
  }

  // ONE account is not the same as "the first account". A token with access to
  // several must not have one picked for it — the wrong one means a database
  // and a Worker created on an account the owner did not intend to bill.
  const chosen = accountId ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
  if (chosen === undefined || chosen === "") {
    return {
      tokenValid: true,
      tokenStatus,
      accounts,
      scopes: null,
      deployment: null,
      error: null,
    };
  }

  const scopes = await deps.api.probeScopes(chosen);
  if (scopes.d1 === "missing" || scopes.workers === "missing") {
    // Deliberately `deployment: null` with `error: null`. Inspecting a
    // deployment the token is not allowed to read is pointless, and the missing
    // permission must reach the screen as data it can render as a named
    // permission — not as an error banner, which is the wording that sent the
    // owner off to re-copy a perfectly good token.
    return { tokenValid: true, tokenStatus, accounts, scopes, deployment: null, error: null };
  }

  try {
    return {
      tokenValid: true,
      tokenStatus,
      accounts,
      scopes,
      deployment: await inspectDeployment({
        api: deps.api,
        accountId: chosen,
        dbName,
        workerName,
      }),
      error: null,
    };
  } catch (err) {
    return {
      tokenValid: true,
      tokenStatus,
      accounts,
      scopes,
      deployment: null,
      error: describeCloudError(err),
    };
  }
}

async function inspectDeployment(o: {
  api: CloudflareApi;
  accountId: string;
  dbName: string;
  workerName: string;
}): Promise<CloudDeploymentState> {
  const api = o.api;
  const database = findDatabase(await api.listDatabases(o.accountId), o.dbName);
  const bindings = await api.getWorkerBindings(o.accountId, o.workerName);

  const registry =
    database === null
      ? { machines: [] as EnrolledMachineRow[], rows: null }
      : await readRegistry(api, o.accountId, database.uuid);

  return {
    accountId: o.accountId,
    databaseExists: database !== null,
    workerExists: bindings !== null,
    machines: registry.machines,
    accountSubdomain: await o.api.getAccountSubdomain(o.accountId),
    rowsInCloud: registry.rows,
    // Tolerant, and it cannot fail the probe: `listZones` already answers
    // `[]` rather than throwing when the token may not read zones, and a
    // missing OPTIONAL permission must never present as a broken account.
    zones: (await api.listZones(o.accountId)).map((z) => ({ id: z.id, name: z.name })),
    workerDomains: (await api.listWorkerDomains(o.accountId)).map((d) => ({
      hostname: d.hostname,
      service: d.service,
    })),
  };
}

/**
 * Who is enrolled, and how many intervals are already here.
 *
 * LEFT JOIN, because a Mac that has enrolled but not yet sent its first
 * heartbeat has no `machine` row and must still appear — as its bare id, which
 * is honest. The label is joined rather than stored on `machine_token` for the
 * reason AGENTS.md gives about `work_interval`: a machine's name has exactly
 * one home, and a second copy is a rename that can half-fail.
 *
 * The row count is shown on the confirmation screen because "this database
 * already has 4,812 intervals in it" is the sentence that stops someone
 * clicking through a wizard that is about to point at the wrong account.
 */
async function readRegistry(
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
): Promise<{ machines: EnrolledMachineRow[]; rows: number | null }> {
  try {
    const [enrolled, counted] = await api.query(
      accountId,
      databaseId,
      `SELECT t.machine_id AS machine_id, t.enrolled_at_ms AS enrolled_at_ms,
              m.label AS label, m.last_seen_ms AS last_seen_ms
         FROM machine_token t
         LEFT JOIN machine m ON m.machine_id = t.machine_id
        WHERE t.revoked_at_ms IS NULL
        ORDER BY t.enrolled_at_ms;` +
        "SELECT COUNT(*) AS n FROM work_interval;",
    );
    const machines = (enrolled ?? [])
      .map((row): EnrolledMachineRow | null => {
        const machineId = stringField(row, "machine_id");
        if (machineId === null || machineId === "") return null;
        return {
          machineId,
          label: stringField(row, "label"),
          enrolledAtMs: numberField(row, "enrolled_at_ms") ?? 0,
          lastSeenMs: numberField(row, "last_seen_ms"),
        };
      })
      .filter((m): m is EnrolledMachineRow => m !== null);
    const first = counted?.[0];
    const n = first === undefined ? null : numberField(first, "n");
    return { machines, rows: n };
  } catch {
    // The tables do not exist until the schema has been applied, and a
    // first run is exactly when that is true. No evidence is not an error.
    return { machines: [], rows: null };
  }
}

/**
 * Read the registry for a screen that already knows the database.
 *
 * Exposed so the review screen can refresh the machine list after a revoke
 * without re-running the whole probe.
 */
export async function readEnrolledMachines(
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
): Promise<EnrolledMachineRow[]> {
  return (await readRegistry(api, accountId, databaseId)).machines;
}

/**
 * Stop one machine syncing, immediately.
 *
 * Nothing it has already recorded is touched — its hours stay in the cloud and
 * on that Mac, and anything it has not yet sent waits in its outbox. Effective
 * on that machine's very next request. Rows are never deleted here for the same
 * reason they are never deleted from `work_interval`: who could write, and
 * when, is history.
 *
 * Requires the Cloudflare API token, i.e. the wizard. There is deliberately no
 * Worker route for this — one would let a stolen bearer token take every other
 * Mac offline.
 */
export async function revokeMachine(o: {
  api: CloudflareApi;
  accountId: string;
  databaseId: string;
  machineId: string;
  now?: () => number;
}): Promise<void> {
  if (!MACHINE_ID.test(o.machineId)) {
    throw new Error(`refusing to revoke: “${o.machineId}” is not a machine id`);
  }
  await o.api.queryParams(
    o.accountId,
    o.databaseId,
    `UPDATE machine_token SET revoked_at_ms = ?
      WHERE machine_id = ? AND revoked_at_ms IS NULL`,
    [String((o.now ?? Date.now)()), o.machineId],
  );
}

/**
 * The whole bring-up.
 *
 * Never throws. Every failure is a value with a sentence in it and a step
 * marked failed, because the caller is a button and a rejected invoke renders
 * as a stack trace. Whatever succeeded before the failure stays done, and
 * running it again picks up from a world that already has those things in it.
 */
export async function runCloudSetup(
  deps: BringupDeps,
  req: CloudSetupRequest,
): Promise<CloudSetupOutcome> {
  const dbName = deps.databaseName ?? DEFAULT_DATABASE_NAME;
  const workerName = deps.workerName ?? DEFAULT_WORKER_NAME;
  const now = deps.now ?? Date.now;
  const tracker = new StepTracker(deps.onProgress);

  let workerUrl: string | null = null;
  let altWorkerUrl: string | null = null;
  let addresses: readonly AddressProbe[] = [];
  let unstoredToken: string | null = null;

  try {
    // ── 1. the token ──────────────────────────────────────────────────────
    tracker.start("token");
    const token = await deps.api.verifyToken();
    if (token.status !== "active") {
      throw new Error(
        `Cloudflare says this token is “${token.status}”, not active. Create a new one.`,
      );
    }
    tracker.done("token", "accepted");

    // ── 2. the account ────────────────────────────────────────────────────
    // Listing the databases is what PROVES the account id: it is the first
    // account-scoped call, so a wrong id and a missing D1 permission are both
    // answered here rather than three steps later against a half-built cloud.
    tracker.start("account");
    if (req.accountId.trim() === "") throw new Error("no Cloudflare account was chosen");
    const databases = await deps.api.listDatabases(req.accountId);
    tracker.done("account", `${String(databases.length)} D1 database(s) on this account`);

    // ── 3. the database ───────────────────────────────────────────────────
    tracker.start("database");
    const existing = findDatabase(databases, dbName);
    let database: D1DatabaseSummary;
    if (existing !== null) {
      database = existing;
      tracker.done("database", `adopted the existing “${dbName}”`);
    } else {
      database = await deps.api.createDatabase(req.accountId, dbName);
      tracker.done("database", `created “${dbName}”`);
    }

    // ── 4. the schema ─────────────────────────────────────────────────────
    tracker.start("schema");
    await deps.api.query(req.accountId, database.uuid, WORKER_SCHEMA_SQL);
    tracker.done("schema", "applied (CREATE TABLE IF NOT EXISTS throughout)");

    // ── 5. enrol THIS Mac ─────────────────────────────────────────────────
    // Mint a token for this machine only, and send Cloudflare its SHA-256. The
    // plaintext never leaves this Mac.
    tracker.start("enrol");
    if (deps.thisMachineId === "") {
      // Unreachable in production — `src/main/bootstrap.ts` falls back to a
      // persisted randomUUID() when ioreg cannot be read — but it must never be
      // silently written if it ever becomes reachable. Every hour would be
      // filed under a blank name, which is the exact silent misattribution this
      // whole design exists to prevent.
      throw new Error(
        "this Mac's hardware UUID could not be read, so setup cannot say whose " +
          "hours these are — every hour would be filed under a blank name. " +
          "`ioreg` is what reports it. Cloud sync should wait until that is " +
          "working; nothing you have already recorded is affected.",
      );
    }
    if (!MACHINE_ID.test(deps.thisMachineId)) {
      throw new Error(
        `this Mac's id is not a shape setup will send (${String(deps.thisMachineId.length)} characters).`,
      );
    }
    const thisToken = deps.mintToken();
    const thisHash = deps.hashToken(thisToken);
    if (!HEX64.test(thisHash)) {
      throw new Error(
        "the token fingerprint came out in an unexpected format, so nothing " +
          "was sent. Nothing was changed and running setup again is safe.",
      );
    }
    // A plain INSERT, no ON CONFLICT. A 256-bit collision is not a case to
    // absorb quietly; if it ever happened the constraint error should fail the
    // run loudly, which is what this does.
    try {
      await deps.api.queryParams(
        req.accountId,
        database.uuid,
        `INSERT INTO machine_token (token_sha256, machine_id, enrolled_at_ms)
         VALUES (?, ?, ?)`,
        [thisHash, deps.thisMachineId, String(now())],
      );
    } catch (err) {
      // Worth its own sentence rather than the bare Cloudflare one. Reaching
      // here means the token was minted and NOT stored anywhere — not in the
      // Keychain, not in Cloudflare — so the honest reassurance is that this
      // changed nothing and can simply be run again. Without it, "enrol failed"
      // reads like a half-built cloud somebody has to go and clean up.
      throw new Error(
        `this Mac could not be enrolled: ${describeCloudError(err)}. Nothing ` +
          `else was changed, and nothing was stored on this Mac. Running setup ` +
          `again is safe.`,
      );
    }
    tracker.done("enrol", "this Mac is enrolled — only its fingerprint was sent");

    // ── 6. the Worker ─────────────────────────────────────────────────────
    tracker.start("deploy");
    await deps.api.uploadWorker(req.accountId, {
      scriptName: workerName,
      script: WORKER_BUNDLE,
      mainModule: WORKER_MAIN_MODULE,
      compatibilityDate: WORKER_COMPATIBILITY_DATE,
      bindings: buildBindings({ databaseId: database.uuid }),
    });
    tracker.done("deploy", "deployed, pointed at this database");

    // ── 6. the address ────────────────────────────────────────────────────
    tracker.start("url");
    let subdomain = await deps.api.getAccountSubdomain(req.accountId);
    if (subdomain === null) {
      // Account-wide, permanent in practice, and it appears in the URL of
      // everything this account ever deploys — so it is asked for on the
      // previous screen rather than invented here. Reaching this branch with
      // nothing chosen means the screen was skipped, not that a default is
      // wanted.
      const wanted = (req.subdomain ?? "").trim();
      if (wanted === "") {
        throw new Error(
          "this Cloudflare account has not chosen a workers.dev subdomain yet. " +
            "It is account-wide and appears in the address of everything you " +
            "deploy, so setup will not pick one for you — go back and enter one.",
        );
      }
      subdomain = await deps.api.createAccountSubdomain(req.accountId, wanted);
      tracker.note("url", `claimed the workers.dev subdomain “${subdomain}”`);
    }
    const enabled = await deps.api.enableWorkersDev(req.accountId, workerName);
    if (!enabled) {
      throw new Error(
        `Cloudflare did not put “${workerName}” on workers.dev. Without an ` +
          `address there is nothing for this Mac to sync to.`,
      );
    }
    // Composed from a subdomain READ BACK off the account and the name the
    // upload was accepted under — then proved in the next step. The API returns
    // no URL of its own, so the proof is the substitute for being told.
    const devUrl = workersDevUrl(workerName, subdomain);

    // ── The optional second address ───────────────────────────────────────
    // EVERY failure in here is a note and never a throw. The `url` step ends
    // `done` as long as workers.dev came up, because a custom domain that could
    // not be attached costs a sentence, not a setup.
    const custom =
      req.customDomain === undefined
        ? { url: null, fresh: false, note: null }
        : await attachCustomDomain({
            api: deps.api,
            accountId: req.accountId,
            workerName,
            request: req.customDomain,
          });
    if (custom.note !== null) tracker.note("url", custom.note);

    // Provisional: `verify` is what decides which one this Mac actually saves.
    // Set now so a failure at the next step still reports an address.
    workerUrl = custom.url ?? devUrl;
    tracker.done(
      "url",
      custom.url === null
        ? custom.note === null
          ? devUrl
          : `workers.dev is on at ${devUrl}. ${custom.note}`
        : custom.note === null
          ? `${custom.url} and ${devUrl}`
          : `${custom.note}; workers.dev is on too`,
    );

    // ── 7. do they answer ─────────────────────────────────────────────────
    tracker.start("verify");
    const collected: AddressProbe[] = [];
    // Collected as they happen rather than returned, so a run that ends with
    // NOTHING answering still carries the report out through the catch below.
    // That is the run the report is worth most on.
    addresses = collected;
    const verified = await verifyAddresses({
      collect: (probe) => collected.push(probe),
      // The custom domain FIRST, and preferred when both answer: the point of
      // adding it was not to depend on workers.dev.
      candidates: [
        ...(custom.url === null
          ? []
          : [{ url: custom.url, kind: "custom" as const, fresh: custom.fresh }]),
        { url: devUrl, kind: "workers.dev" as const, fresh: false },
      ],
      token: thisToken,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      sleep: deps.sleep ?? realSleep,
      now,
      note: (detail) => tracker.note("verify", detail),
    });
    workerUrl = verified.chosen;
    altWorkerUrl = collected.map((a) => a.url).find((u) => u !== verified.chosen) ?? null;
    tracker.done("verify", verifyDetail(collected, verified.chosen));

    // ── 8. this Mac ───────────────────────────────────────────────────────
    // LAST, and only now: the local half is written once the deployed Worker
    // has answered on this URL with this token. Storing it any earlier would
    // mean a green "sync is on" for a Worker that never replied.
    tracker.start("save");
    try {
      await deps.commit({ workerUrl, altWorkerUrl, token: thisToken });
    } catch (err) {
      // The cloud half is real and correct; only the keychain refused. Handing
      // the token over is strictly better than reporting a failure for a
      // deployment that actually works. The older tokens are deliberately NOT
      // revoked here: the new one is not stored, so an older one may still be
      // the only working credential this Mac has.
      unstoredToken = thisToken;
      tracker.fail("save", describeCloudError(err));
      return {
        ...tracker.snapshot(
          "Everything in the cloud is set up. This Mac could not store its own " +
            "token — copy it below and paste it into Cloud sync.",
        ),
        ok: false,
        workerUrl,
        altWorkerUrl,
        addresses,
        unstoredToken,
      };
    }

    // ── Retire this Mac's OLDER tokens — and only now ─────────────────────
    //
    // THE ORDERING IS THE DESIGN. Do not tidy these two statements into one.
    //
    //  • Insert before revoke. If this UPDATE fails, the machine has TWO live
    //    tokens — harmless, because both stamp the same machine_id, and the
    //    next run clears it. Revoke-first would leave a machine with ZERO live
    //    tokens on a partial failure: offline, silently.
    //  • Revoke after the Keychain write. Until the new token is stored and
    //    proven, the old one is the only working credential this Mac has.
    //    Revoking earlier means a run that fails at the save step leaves the
    //    Mac unable to sync until setup is run again.
    //  • `machine_id = ?` scopes it to THIS Mac. No other machine's row is ever
    //    touched by a setup run.
    //  • A failed revoke does not fail the run. An extra live token for the
    //    same machine is not worth failing a setup that otherwise worked.
    let revokeNote = "sync is on — no relaunch needed";
    try {
      await deps.api.queryParams(
        req.accountId,
        database.uuid,
        `UPDATE machine_token SET revoked_at_ms = ?
          WHERE machine_id = ? AND token_sha256 <> ? AND revoked_at_ms IS NULL`,
        [String(now()), deps.thisMachineId, thisHash],
      );
    } catch {
      revokeNote =
        "sync is on — an older token for this Mac could not be revoked; " +
        "run setup again to clear it";
    }
    tracker.done("save", revokeNote);

    return {
      ...tracker.snapshot(null),
      ok: true,
      workerUrl,
      altWorkerUrl,
      addresses,
      unstoredToken: null,
    };
  } catch (err) {
    const message = describeCloudError(err);
    tracker.failCurrent(message);
    return {
      ...tracker.snapshot(message),
      ok: false,
      workerUrl,
      altWorkerUrl,
      // A failed run is exactly when the address report is worth most.
      addresses,
      unstoredToken,
    };
  }
}

/**
 * The bindings the upload carries — the whole set, because an upload replaces
 * every one of them.
 *
 * There is exactly one now. Per-machine tokens used to be `secret_text`
 * bindings, which is why this function once had to carry the other Mac's token
 * forward with `{type:"inherit"}` and why every upload had to go out under
 * `?bindings_inherit=strict` — an inherit that cannot be resolved is otherwise
 * DROPPED behind a 200, and that is the other Mac offline with a green tick.
 * Credentials now live in D1, so there is nothing to inherit and nothing an
 * upload can silently delete. The flag stays on the request anyway: it costs
 * nothing and it is the guarantee any future binding will want.
 */
export function buildBindings(o: { databaseId: string }): WorkerBinding[] {
  return [{ type: "d1", name: DB_BINDING, database_id: o.databaseId }];
}

/**
 * Put the Worker on a domain the owner already owns — or say, in one sentence,
 * why it is still only on workers.dev.
 *
 * NEVER THROWS. That is the whole contract: workers.dev is already on by the
 * time this runs, so a custom domain that could not be attached is a note on a
 * step that still ends `done`. A second address failing must not cost anybody a
 * working setup.
 *
 * The `GET` runs before the `PUT` because refusing early with a sentence the
 * owner understands beats a Cloudflare error code they have to decode — and
 * because a hostname already pointed at somebody ELSE's Worker is a thing to
 * leave alone rather than to try and find out about by attempting it.
 */
async function attachCustomDomain(o: {
  api: CloudflareApi;
  accountId: string;
  workerName: string;
  request: CustomDomainRequest;
}): Promise<{ url: string | null; fresh: boolean; note: string | null }> {
  const skipped = (note: string) => ({ url: null, fresh: false, note });

  const label = o.request.label.trim().toLowerCase();
  const zoneName = o.request.zone.name.trim().toLowerCase();
  const labelProblem = hostnameLabelError(label);
  if (labelProblem !== null) return skipped(`no custom domain was added: ${labelProblem}`);
  const zoneProblem = zoneNameError(zoneName);
  if (zoneProblem !== null) return skipped(`no custom domain was added: ${zoneProblem}`);

  const hostname = `${label}.${zoneName}`;
  const url = customDomainUrl(label, zoneName);

  let taken: Awaited<ReturnType<CloudflareApi["findWorkerDomain"]>>;
  try {
    taken = await o.api.findWorkerDomain(o.accountId, hostname);
  } catch (err) {
    return skipped(
      `“${hostname}” could not be checked (${describeCloudError(err)}), so setup ` +
        `left it alone.`,
    );
  }
  if (taken === null) {
    // "Cannot tell" is not "nothing there". Attaching a hostname that was never
    // actually checked is the one thing this branch exists to prevent.
    return skipped(
      `“${hostname}” could not be checked — this token may not read Worker ` +
        `domains — so setup left it alone.`,
    );
  }
  if (taken !== undefined && taken.service !== o.workerName) {
    return skipped(
      `“${hostname}” is already the address of a different Worker ` +
        `(“${taken.service}”). Setup left it alone.`,
    );
  }
  if (taken !== undefined) {
    // Already ours. No PUT at all — re-running setup must be free, and the
    // cheapest way for a re-attach to be harmless is for it not to happen.
    return { url, fresh: false, note: `already on ${url}` };
  }

  try {
    await o.api.attachWorkerDomain(o.accountId, {
      hostname,
      service: o.workerName,
      zone: "id" in o.request.zone ? { id: o.request.zone.id } : { name: zoneName },
    });
    return { url, fresh: true, note: null };
  } catch (err) {
    if (isConflictingDnsRecord(err)) {
      // Matched on the numeric code, never the message: Cloudflare has already
      // changed that text once, and it currently recommends an override flag
      // this endpoint does not have and which could not overwrite a non-Worker
      // record even where it does.
      return skipped(
        `“${hostname}” was not added: a DNS record already exists at that name ` +
          `on ${zoneName}. Cloudflare will not replace it, and neither will ` +
          `setup. Remove it, or pick a different name and run setup again.`,
      );
    }
    return skipped(`“${hostname}” was not added: ${describeCloudError(err)}`);
  }
}

/** Today's ladder — about 79 seconds. Unchanged, and used for anything not new. */
const VERIFY_WAITS = [0, 2000, 4000, 8000, 15_000, 20_000, 30_000];

/**
 * The ladder for an address created SECONDS ago — about three minutes.
 *
 * THREE MINUTES IS A JUDGEMENT, NOT A MEASUREMENT. Cloudflare documents no
 * issuance SLA for the Advanced Certificate a custom domain generates; the
 * launch blog says only "in seconds", and the status machine runs Initializing
 * → Pending Validation → Pending Issuance → Pending Deployment → Active.
 * `docs/CLOUDFLARE.md` measured about two minutes for the workers.dev
 * certificate on this account, so three is that with room.
 *
 * Exhausting it is NOT a failure: setup falls back to the other address and
 * says the new one may answer later. Do not tidy that into a hard failure.
 */
const FRESH_DOMAIN_WAITS = [
  0, 3000, 5000, 10_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

/**
 * Ask every address this Mac now has, and KEEP the answers.
 *
 * One address answering is enough to proceed. The ones that did NOT answer are
 * kept rather than discarded, and that is the whole diagnostic: an owner whose
 * work Mac fails here now gets a sentence saying which address failed and why.
 *
 * The custom domain is tried first and preferred when both work, because the
 * point of adding it was not to depend on workers.dev.
 *
 * ── WHY ONLY THE FIRST ONE TO ANSWER IS AUTHENTICATED ───────────────────────
 * The token is a property of the WORKER — same script, same D1, same
 * `machine_token` row — so proving it once proves it. `assertAuthorized`'s own
 * retry exists for a redeploy that has not reached every colo, which is
 * per-deployment and not per-host. The remaining addresses get one `/health`
 * each, purely to complete the report.
 */
async function verifyAddresses(o: {
  candidates: readonly { url: string; kind: AddressProbe["kind"]; fresh: boolean }[];
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  note: (detail: string) => void;
  /**
   * Handed out one at a time rather than returned in a lump, because the case
   * that matters most is the one where this function THROWS: no address
   * answered, and the report of what each one did is the entire value of the
   * run.
   */
  collect: (probe: AddressProbe) => void;
  // `chosen` is never null on the way out: nothing answering THROWS, so the
  // caller does not get a "succeeded with no address" state to handle.
}): Promise<{ chosen: string }> {
  const probes: AddressProbe[] = [];
  const push = (probe: AddressProbe): void => {
    probes.push(probe);
    o.collect(probe);
  };
  let chosen: string | null = null;

  for (const candidate of o.candidates) {
    const startedMs = o.now();
    const health = await probeHealth({
      ...o,
      candidate,
      // Once something has answered, the rest are one shot for the report. A
      // second three-minute ladder on an address nobody is waiting for would
      // be three minutes of a spinner for a line of diagnostics.
      waits: chosen !== null ? [0] : candidate.fresh ? FRESH_DOMAIN_WAITS : VERIFY_WAITS,
    });
    const ms = o.now() - startedMs;

    if (health !== null) {
      push({ ...candidate, reachable: false, error: health, ms });
      continue;
    }
    if (chosen !== null) {
      push({ ...candidate, reachable: true, error: null, ms });
      continue;
    }

    // The first address to answer proves the token. A refusal by the ZONE is
    // the one failure that belongs to this hostname rather than to the Worker,
    // so it is recorded and the next candidate is tried; anything else is about
    // the deployment and throws, exactly as it did before there were two.
    const refusal = await assertAuthorized({ ...o, baseUrl: candidate.url });
    if (refusal !== null) {
      push({ ...candidate, reachable: false, error: refusal, ms: o.now() - startedMs });
      continue;
    }
    chosen = candidate.url;
    push({ ...candidate, reachable: true, error: null, ms });
  }

  if (chosen === null) {
    throw new Error(
      `the Worker was deployed but none of its addresses answered from this Mac. ` +
        probes.map((p) => `${p.url}/health — ${p.error ?? "no reason given"}`).join("; ") +
        `. api.cloudflare.com WAS reachable from here a moment ago, so the network ` +
        `is up and it is these hostnames specifically. The deployment is finished ` +
        `and re-running setup is safe.`,
    );
  }
  return { chosen };
}

/**
 * Does this address answer `/health` at all? Null when it does; the reason when
 * it does not.
 *
 * ── THE WAIT IS NOT PADDING ─────────────────────────────────────────────────
 * A brand-new hostname resolves in DNS before its TLS certificate has been
 * issued — measured at about two minutes on this account's first setup. macOS
 * `curl` reports that as `sslv3 alert handshake failure`, which reads exactly
 * like a real error and is not.
 *
 * ── BUT ONLY FOR THINGS THAT COULD BE A CERTIFICATE ─────────────────────────
 * A refused connection, a reset by a proxy or an HTTP status is an ANSWER, not
 * a certificate still being issued, and waiting three minutes on one is a bug
 * rather than patience. So the ladder continues only while the failure is one a
 * minute-old address would give — or while the failure cannot be identified at
 * all, which is the case a bare `TypeError: fetch failed` with no cause leaves
 * us in and which there is no evidence to rule out.
 */
async function probeHealth(o: {
  candidate: { url: string; kind: AddressProbe["kind"]; fresh: boolean };
  waits: readonly number[];
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  note: (detail: string) => void;
}): Promise<string | null> {
  const host = hostOf(o.candidate.url);
  let last = "";
  for (const [i, wait] of o.waits.entries()) {
    if (wait > 0) {
      o.note(
        o.candidate.fresh
          ? `waiting for ${host} — a new address's certificate usually takes a ` +
              `couple of minutes (attempt ${String(i + 1)})`
          : `waiting for the new address's certificate — this takes a couple of ` +
              `minutes the first time (attempt ${String(i + 1)})`,
      );
      await o.sleep(wait);
    }
    try {
      const res = await o.fetchImpl(`${o.candidate.url}/health`);
      if (res.ok) return null;
      const challenge = challengeSentence(res, o.candidate.url);
      if (challenge !== null) return challenge;
      last = `${o.candidate.url}/health answered ${String(res.status)}`;
    } catch (err) {
      last = describeFetchFailure(err);
      if (!worthWaitingFor(err)) return last;
    }
  }
  return last;
}

/** Only a certificate that may not exist yet, or a failure we cannot name. */
function worthWaitingFor(err: unknown): boolean {
  return isTlsNotReady(err) || describeFetchFailure(err) === "fetch failed";
}

/**
 * A Cloudflare challenge page, rather than a refusal by the Worker.
 *
 * THE WORST FAILURE THIS FEATURE COULD PRODUCE is a silent, permanent 403 on a
 * perfectly good token. A custom domain routes through the ZONE and workers.dev
 * does not, so everything configured on that domain — Bot Fight Mode, WAF
 * rules, rate limiting, "I'm Under Attack", Cloudflare Access — suddenly
 * applies to sync traffic, and a challenge is unsolvable by a `fetch` client.
 * Reported as "the token was rejected" it would send someone to re-run a setup
 * that is already right, for ever.
 *
 * The CONTENT TYPE is the whole test, and the body is never read into a
 * message: an HTML page in an error toast tells the reader nothing and could
 * echo the request back at them.
 */
function challengeSentence(res: Response, baseUrl: string): string | null {
  const html = (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (!html || (res.status !== 403 && res.status !== 503)) return null;
  return (
    `${baseUrl} answered ${String(res.status)} with a Cloudflare challenge page. ` +
    `That is the zone's security settings, not the token — check Bot Fight Mode, ` +
    `WAF rules and Access for that domain in the Cloudflare dashboard. The ` +
    `workers.dev address is unaffected.`
  );
}

/**
 * Does the token this run just uploaded actually work?
 *
 * Resolves NULL when it does, a sentence when the ZONE refused this hostname,
 * and THROWS for anything else — because everything else is a fact about the
 * deployment rather than about which address was used, and would be equally
 * true of every other address.
 *
 * RETRIED, and not for the same reason `/health` is. On a REDEPLOY the hostname
 * has existed for months, so `/health` answers instantly — from whichever
 * version is live at that instant. A new version reaches every colo in seconds
 * rather than atomically, so the first authenticated read can legitimately hit
 * the previous one and 401 on a token that is completely correct. Reporting
 * that as "the Worker rejected the token this setup just created" would send
 * someone to re-run a deployment that is already right.
 *
 * A few seconds of patience, then it is a real failure and says so.
 */
async function assertAuthorized(o: {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const waits = [0, 1000, 2000, 4000, 8000];
  let status = 0;
  for (const wait of waits) {
    if (wait > 0) await o.sleep(wait);
    const res = await o.fetchImpl(`${o.baseUrl}/machines`, {
      headers: { authorization: `Bearer ${o.token}` },
    });
    if (res.ok) return null;
    status = res.status;
    // A challenge is not a version that has not propagated yet, and no amount
    // of waiting solves one. Out of the ladder immediately.
    const challenge = challengeSentence(res, o.baseUrl);
    if (challenge !== null) return challenge;
    // 401/403 and 503 are both worth waiting on, for the same reason: a version
    // that is not live everywhere yet. 503 specifically is the old Worker
    // answering before the new schema reached it.
    if (status !== 401 && status !== 403 && status !== 503) break;
  }
  if (status === 503) {
    throw new Error(
      `the Worker is running, but its database has no machine registry yet — ` +
        `the schema was never applied. Run “Set up cloud sync” again; it applies ` +
        `the schema and changes nothing else.`,
    );
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `the Worker is reachable but did not accept the token this setup just ` +
        `enrolled. The database row is in place, so the likeliest cause is that ` +
        `the Worker is pointed at a different D1 database than the one setup ` +
        `wrote to. Running setup again is safe — it will re-check and re-point it.`,
    );
  }
  throw new Error(
    `the Worker is reachable but an authenticated read answered ${String(status)}.`,
  );
}

/** The one line the finished `verify` step shows. */
function verifyDetail(probes: readonly AddressProbe[], chosen: string): string {
  if (probes.length <= 1) return "reachable, and this Mac's token was accepted";
  const failed = probes.filter((p) => !p.reachable);
  if (failed.length === 0) return `both addresses answered; using ${chosen}`;
  return (
    failed.map((p) => `${p.url} did not answer (${p.error ?? "no reason given"})`).join("; ") +
    `; using ${chosen}`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adopt by EXACT name.
 *
 * The list endpoint takes a `name` filter but the documentation only calls it
 * "a database name to search for" — it does not say whether it is exact or a
 * prefix. A prefix match that adopted `wwb-old` would point the Worker at the
 * wrong database and nothing would say so, so the whole list is fetched and
 * matched here where the rule is visible.
 */
export function findDatabase(
  databases: readonly D1DatabaseSummary[],
  name: string,
): D1DatabaseSummary | null {
  return databases.find((d) => d.name === name) ?? null;
}

function stringField(row: unknown, key: string): string | null {
  if (typeof row !== "object" || row === null) return null;
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function numberField(row: unknown, key: string): number | null {
  if (typeof row !== "object" || row === null) return null;
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The progress list, always complete.
 *
 * Every emission is the whole array rather than the step that changed, for the
 * same reason every push in `src/main/ipc.ts` is a whole snapshot: deltas need
 * ordering guarantees IPC does not give you, and a wizard that drops one update
 * shows a step stuck on "running" for ever.
 */
class StepTracker {
  private readonly steps = new Map<CloudStepId, CloudStep>(
    STEP_ORDER.map((id) => [
      id,
      { id, label: STEP_LABEL[id], state: "pending" as StepState, detail: null },
    ]),
  );
  private current: CloudStepId | null = null;

  constructor(private readonly onProgress?: (p: CloudSetupProgress) => void) {}

  private set(id: CloudStepId, state: StepState, detail: string | null): void {
    this.steps.set(id, { id, label: STEP_LABEL[id], state, detail });
    this.onProgress?.(this.snapshot(null));
  }

  start(id: CloudStepId): void {
    this.current = id;
    this.set(id, "running", null);
  }

  note(id: CloudStepId, detail: string): void {
    this.set(id, "running", detail);
  }

  done(id: CloudStepId, detail: string | null): void {
    this.current = null;
    this.set(id, "done", detail);
  }

  fail(id: CloudStepId, detail: string): void {
    this.current = null;
    this.set(id, "failed", detail);
  }

  failCurrent(detail: string): void {
    if (this.current !== null) this.fail(this.current, detail);
  }

  snapshot(error: string | null): CloudSetupProgress {
    const steps = STEP_ORDER.map((id) => this.steps.get(id)).filter(
      (s): s is CloudStep => s !== undefined,
    );
    return { steps, done: steps.every((s) => s.state === "done"), error };
  }
}
