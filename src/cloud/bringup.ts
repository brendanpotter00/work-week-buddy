/**
 * `scripts/bringup-cloud.sh`, as something the app does.
 *
 * The shell script is the specification and this is the port of it: create or
 * ADOPT the D1 database, apply the schema, deploy the Worker, mint the
 * per-machine tokens, and print the one that has to be carried to the other
 * Mac. What changes is only the mechanism — the Cloudflare REST API instead of
 * `npx wrangler`, which means no terminal, no `wrangler login`, and no Node
 * toolchain on a Mac that only ever wanted to know how many hours it worked.
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
 *   deploy     an upload replaces the script; the tokens are carried across.
 *   subdomain  claimed only when the account has none.
 *   save       the local half is written LAST, once the deployed Worker has
 *              answered on the URL with the token — never on the strength of a
 *              200 from the upload.
 *
 * ── THE SECRET THAT CANNOT BE READ BACK ─────────────────────────────────────
 * Uploading a Worker replaces its bindings, and the other Mac's token is a
 * binding whose value Cloudflare will not disclose. It survives because the
 * upload carries `{type:"inherit", name:"TOKEN_WORK"}` and goes out with
 * `?bindings_inherit=strict`, so an inherit that cannot be resolved FAILS the
 * upload instead of being silently dropped. Silently dropping it would take the
 * other Mac offline with a green tick on this screen. See `api.ts`.
 *
 * ── NOTHING HERE BLOCKS, LOGS, OR PERSISTS THE API TOKEN ────────────────────
 * Every step is async I/O and reports progress as it goes, so the window
 * repaints throughout. The Cloudflare API token lives in the `CloudflareApi`
 * object this module is handed and is never written down: not to
 * `settings.json`, not to the keychain, not to `wwb.log`, and not into any
 * string that reaches a screen — `errors.ts` redacts as a backstop.
 */
import {
  workersDevUrl,
  type CloudflareApi,
  type D1DatabaseSummary,
  type ReadBinding,
  type WorkerBinding,
} from "./api";
import { describeCloudError } from "./errors";
import {
  OTHER_SLOT,
  SLOT_BINDING,
  detectSlot,
  type MachineSlot,
  type SlotEvidence,
  type SlotVerdict,
} from "./slot";
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
  | "deploy"
  | "url"
  | "verify"
  | "save";

export const STEP_LABEL: Record<CloudStepId, string> = {
  token: "Check the API token",
  account: "Find the Cloudflare account",
  database: "Create or adopt the database",
  schema: "Apply the schema",
  deploy: "Deploy the Worker",
  url: "Turn on the workers.dev address",
  verify: "Check it answers",
  save: "Turn on sync here",
};

export const STEP_ORDER: readonly CloudStepId[] = [
  "token",
  "account",
  "database",
  "schema",
  "deploy",
  "url",
  "verify",
  "save",
];

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

export interface CloudSetupOutcome extends CloudSetupProgress {
  readonly ok: boolean;
  readonly workerUrl: string | null;
  readonly slot: MachineSlot;
  readonly otherSlot: MachineSlot;
  /**
   * The OTHER Mac's token, minted this run.
   *
   * Null when that Mac already had one and it was left alone — which is the
   * ordinary second-run answer, and the reason re-running here does not knock
   * the other Mac offline. When it IS set, this is the only time it exists
   * anywhere outside Cloudflare: it is not stored, not logged, and cannot be
   * read back. The screen says so.
   */
  readonly otherMachineToken: string | null;
  /**
   * This Mac's token — set ONLY when it could not be stored locally, which on
   * macOS means the keychain refused. Then the owner can paste it into the
   * Cloud sync form by hand rather than being told setup half-worked.
   */
  readonly unstoredToken: string | null;
}

/** What is out there, before anything is changed. */
export interface CloudProbe {
  readonly tokenValid: boolean;
  readonly tokenStatus: string;
  /** Empty when the token may not enumerate accounts — then ask for the id. */
  readonly accounts: ReadonlyArray<{ id: string; name: string }>;
  readonly deployment: CloudDeploymentState | null;
  readonly error: string | null;
}

export interface CloudDeploymentState {
  readonly accountId: string;
  readonly databaseExists: boolean;
  readonly workerExists: boolean;
  readonly verdict: SlotVerdict;
  /**
   * Binding NAMES on the deployed script — never a value.
   *
   * Carried out whole rather than reduced to a boolean here, because whether
   * "the other Mac already has a token" depends on which slot this Mac ends up
   * taking, and that is not settled until the owner has seen the verdict. The
   * caller asks `otherTokenPresent(names, slot)` once it is.
   */
  readonly bindingNames: readonly string[];
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
}

export interface BringupDeps {
  readonly api: CloudflareApi;
  /** This Mac's IOPlatformUUID. "" when `ioreg` could not be read. */
  readonly thisMachineId: string;
  /** 32 cryptographically random bytes, base64 — `randomBytes(32)` in main. */
  readonly mintToken: () => string;
  /**
   * Persist this Mac's token through `safeStorage` and set `syncWorkerUrl`, so
   * sync is live with no relaunch. Throws when there is no keychain, which is
   * the one failure the outcome answers by showing the token instead.
   */
  readonly commit: (c: { workerUrl: string; token: string }) => Promise<void>;
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
  readonly slot: MachineSlot;
  /**
   * Mint a new token for the OTHER Mac even though it already has one.
   *
   * Off by default and deliberately opt-in: a re-run that quietly reset the
   * other Mac's token would take it offline with no error anywhere until
   * somebody noticed its row count had stopped moving. The same rule
   * `bringup-cloud.sh` keeps with `--rotate`.
   */
  readonly rotateOtherToken?: boolean;
  /**
   * A workers.dev subdomain to claim, used ONLY when the account has none.
   *
   * Ignored when one already exists — this never renames an account's
   * subdomain, and the probe reports `accountSubdomain` so the screen knows
   * whether to ask at all.
   */
  readonly subdomain?: string;
}

/**
 * Look, change nothing.
 *
 * Runs before the wizard offers to do anything, so the screen that asks for
 * confirmation can say what already exists rather than what it intends. It is
 * also what decides the slot, and it is entirely read-only: a probe that
 * created something would make "cancel" a lie.
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
      deployment: null,
      error: describeCloudError(err),
    };
  }
  if (tokenStatus !== "active") {
    return {
      tokenValid: false,
      tokenStatus,
      accounts: [],
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
      deployment: null,
      error: describeCloudError(err),
    };
  }

  // ONE account is not the same as "the first account". A token with access to
  // several must not have one picked for it — the wrong one means a database
  // and a Worker created on an account the owner did not intend to bill.
  const chosen = accountId ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
  if (chosen === undefined || chosen === "") {
    return { tokenValid: true, tokenStatus, accounts, deployment: null, error: null };
  }

  try {
    return {
      tokenValid: true,
      tokenStatus,
      accounts,
      deployment: await inspectDeployment({
        api: deps.api,
        accountId: chosen,
        dbName,
        workerName,
        thisMachineId: deps.thisMachineId,
      }),
      error: null,
    };
  } catch (err) {
    return {
      tokenValid: true,
      tokenStatus,
      accounts,
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
  thisMachineId: string;
}): Promise<CloudDeploymentState> {
  const api = o.api;
  const database = findDatabase(await api.listDatabases(o.accountId), o.dbName);
  const bindings = await api.getWorkerBindings(o.accountId, o.workerName);
  const workerExists = bindings !== null;
  // Secret NAMES come from the dedicated endpoint, which is documented to omit
  // every value. The settings response also lists them, but the schema leaves
  // it ambiguous whether a secret's `text` is redacted there — so the names are
  // taken from the endpoint that promises nothing sensitive comes back.
  const secretNames = workerExists
    ? await api.listWorkerSecretNames(o.accountId, o.workerName)
    : [];
  const bindingNames = [
    ...new Set([...(bindings ?? []).map((b) => b.name), ...secretNames]),
  ];

  // Only asked for when it can decide something: the stamped ids matter solely
  // to the rule that covers a deployment `bringup-cloud.sh` configured, and
  // there is no database to ask before the first run.
  const stamped: { ids: string[]; rows: number | null } =
    database === null
      ? { ids: [], rows: null }
      : await readStampedMachineIds(api, o.accountId, database.uuid);

  const evidence: SlotEvidence = {
    thisMachineId: o.thisMachineId,
    readableMachineIdPersonal: readablePlainText(bindings, SLOT_BINDING.personal.machineId),
    readableMachineIdWork: readablePlainText(bindings, SLOT_BINDING.work.machineId),
    bindingNames,
    stampedMachineIds: stamped.ids,
    workerExists,
  };

  return {
    accountId: o.accountId,
    databaseExists: database !== null,
    workerExists,
    verdict: detectSlot(evidence),
    bindingNames,
    accountSubdomain: await o.api.getAccountSubdomain(o.accountId),
    rowsInCloud: stamped.rows,
  };
}

/**
 * The machine ids the cloud has actually stamped, and how many rows exist.
 *
 * Both come out of one query. The row count is shown on the confirmation screen
 * because "this database already has 4,812 intervals in it" is the sentence
 * that stops someone clicking through a wizard that is about to point at the
 * wrong account.
 */
async function readStampedMachineIds(
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
): Promise<{ ids: string[]; rows: number | null }> {
  try {
    const [machines, intervals, counted] = await api.query(
      accountId,
      databaseId,
      "SELECT machine_id FROM machine;" +
        "SELECT DISTINCT machine_id FROM work_interval;" +
        "SELECT COUNT(*) AS n FROM work_interval;",
    );
    const ids = [...(machines ?? []), ...(intervals ?? [])]
      .map((row) => stringField(row, "machine_id"))
      .filter((v): v is string => v !== null && v !== "");
    const first = counted?.[0];
    const n = first === undefined ? null : numberField(first, "n");
    return { ids: [...new Set(ids)], rows: n };
  } catch {
    // The tables do not exist until the schema has been applied, and a
    // first run is exactly when that is true. No evidence is not an error.
    return { ids: [], rows: null };
  }
}

/** Does the other slot already hold a token that must be left alone? */
export function otherTokenPresent(
  bindingNames: readonly string[],
  slot: MachineSlot,
): boolean {
  return bindingNames.includes(SLOT_BINDING[OTHER_SLOT[slot]].token);
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
  const otherSlot = OTHER_SLOT[req.slot];
  const tracker = new StepTracker(deps.onProgress);

  let workerUrl: string | null = null;
  let otherMachineToken: string | null = null;
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

    // ── 5. the Worker ─────────────────────────────────────────────────────
    tracker.start("deploy");
    const bindings = await deps.api.getWorkerBindings(req.accountId, workerName);
    const secretNames =
      bindings === null ? [] : await deps.api.listWorkerSecretNames(req.accountId, workerName);
    const existingNames = new Set([
      ...(bindings ?? []).map((b) => b.name),
      ...secretNames,
    ]);

    const thisToken = deps.mintToken();
    const otherHasToken = existingNames.has(SLOT_BINDING[otherSlot].token);
    // Minted only when the other Mac has none, or when replacing it was asked
    // for explicitly. Anything else and its token is inherited untouched.
    const mintOther = !otherHasToken || req.rotateOtherToken === true;
    otherMachineToken = mintOther ? deps.mintToken() : null;

    await deps.api.uploadWorker(req.accountId, {
      scriptName: workerName,
      script: WORKER_BUNDLE,
      mainModule: WORKER_MAIN_MODULE,
      compatibilityDate: WORKER_COMPATIBILITY_DATE,
      bindings: buildBindings({
        databaseId: database.uuid,
        slot: req.slot,
        thisToken,
        thisMachineId: deps.thisMachineId,
        otherToken: otherMachineToken,
        existingNames,
      }),
    });
    tracker.done(
      "deploy",
      mintOther
        ? `deployed; minted a token for the ${otherSlot} Mac`
        : `deployed; the ${otherSlot} Mac's token was left alone`,
    );

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
    workerUrl = workersDevUrl(workerName, subdomain);
    tracker.done("url", workerUrl);

    // ── 7. does it answer ─────────────────────────────────────────────────
    tracker.start("verify");
    await verifyWorker({
      baseUrl: workerUrl,
      token: thisToken,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      sleep: deps.sleep ?? realSleep,
      note: (detail) => tracker.note("verify", detail),
    });
    tracker.done("verify", "reachable, and this Mac's token was accepted");

    // ── 8. this Mac ───────────────────────────────────────────────────────
    // LAST, and only now: the local half is written once the deployed Worker
    // has answered on this URL with this token. Storing it any earlier would
    // mean a green "sync is on" for a Worker that never replied.
    tracker.start("save");
    try {
      await deps.commit({ workerUrl, token: thisToken });
      tracker.done("save", "sync is on — no relaunch needed");
    } catch (err) {
      // The cloud half is real and correct; only the keychain refused. Handing
      // the token over is strictly better than reporting a failure for a
      // deployment that actually works.
      unstoredToken = thisToken;
      tracker.fail("save", describeCloudError(err));
      return {
        ...tracker.snapshot(
          "Everything in the cloud is set up. This Mac could not store its own " +
            "token — copy it below and paste it into Cloud sync.",
        ),
        ok: false,
        workerUrl,
        slot: req.slot,
        otherSlot,
        otherMachineToken,
        unstoredToken,
      };
    }

    return {
      ...tracker.snapshot(null),
      ok: true,
      workerUrl,
      slot: req.slot,
      otherSlot,
      otherMachineToken,
      unstoredToken: null,
    };
  } catch (err) {
    const message = describeCloudError(err);
    tracker.failCurrent(message);
    return {
      ...tracker.snapshot(message),
      ok: false,
      workerUrl,
      slot: req.slot,
      otherSlot,
      // Shown even on failure when it was minted BEFORE the failure: the upload
      // may well have landed it in Cloudflare, and a token that exists up there
      // and nowhere else is the one thing that cannot be recovered by re-running.
      otherMachineToken,
      unstoredToken,
    };
  }
}

/**
 * The bindings the upload carries — the whole set, because an upload replaces
 * every one of them.
 *
 * Four rules, and the third is the one that keeps two Macs working:
 *
 *   DB                     always, pointed at the database adopted above
 *   this Mac's token       always freshly minted; nothing can read the old one
 *   this Mac's machine id  PLAIN TEXT, on purpose — see `slot.ts`. It is not a
 *                          secret, and one that can be read back is what makes
 *                          the next run on either Mac able to tell which is
 *                          which instead of asking.
 *   the other Mac's pair   `inherit` when present and not being rotated, so its
 *                          token survives an upload that cannot read it; a new
 *                          `secret_text` when there was none or a rotation was
 *                          asked for; and OMITTED when it has never existed —
 *                          `inherit` on a name the previous version does not
 *                          have would fail the upload under `strict`.
 */
export function buildBindings(o: {
  databaseId: string;
  slot: MachineSlot;
  thisToken: string;
  thisMachineId: string;
  otherToken: string | null;
  existingNames: ReadonlySet<string>;
}): WorkerBinding[] {
  const mine = SLOT_BINDING[o.slot];
  const theirs = SLOT_BINDING[OTHER_SLOT[o.slot]];
  const out: WorkerBinding[] = [
    { type: "d1", name: DB_BINDING, database_id: o.databaseId },
    { type: "secret_text", name: mine.token, text: o.thisToken },
  ];

  // An unreadable machine id is worse than none: the Worker falls back to the
  // slot name, which is coherent, whereas an empty string would be stamped onto
  // every row this Mac ever writes.
  if (o.thisMachineId !== "") {
    out.push({ type: "plain_text", name: mine.machineId, text: o.thisMachineId });
  } else if (o.existingNames.has(mine.machineId)) {
    out.push({ type: "inherit", name: mine.machineId });
  }

  if (o.otherToken !== null) {
    out.push({ type: "secret_text", name: theirs.token, text: o.otherToken });
  } else if (o.existingNames.has(theirs.token)) {
    out.push({ type: "inherit", name: theirs.token });
  }
  if (o.existingNames.has(theirs.machineId)) {
    out.push({ type: "inherit", name: theirs.machineId });
  }
  return out;
}

/**
 * Prove the URL, then prove the token — in that order, because they fail for
 * different reasons and the order is the diagnosis.
 *
 * `/health` is unauthenticated on purpose (`worker/src/routes.ts`) and is the
 * only question worth asking first: can this Mac reach the thing at all. The
 * authenticated read after it is the only way to learn that the URL is perfect
 * and the token is not.
 *
 * ── THE WAIT IS NOT PADDING ─────────────────────────────────────────────────
 * A brand-new workers.dev hostname resolves in DNS before its TLS certificate
 * has been issued — measured at about two minutes on this account's first
 * setup. macOS `curl` reports that as `sslv3 alert handshake failure`, which
 * reads exactly like a real error and is not. So the first minutes of failure
 * are retried rather than reported.
 */
async function verifyWorker(o: {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  note: (detail: string) => void;
}): Promise<void> {
  const waits = [0, 2000, 4000, 8000, 15_000, 20_000, 30_000];
  let last = "";
  for (const [i, wait] of waits.entries()) {
    if (wait > 0) {
      o.note(
        `waiting for the new address's certificate — this takes a couple of ` +
          `minutes the first time (attempt ${String(i + 1)})`,
      );
      await o.sleep(wait);
    }
    try {
      const res = await o.fetchImpl(`${o.baseUrl}/health`);
      if (res.ok) {
        await assertAuthorized(o);
        return;
      }
      last = `GET ${o.baseUrl}/health answered ${String(res.status)}`;
    } catch (err) {
      last = describeCloudError(err);
    }
  }
  throw new Error(
    `the Worker was deployed but ${o.baseUrl}/health never answered (${last}). ` +
      `The deployment is done and re-running setup is safe; on a work Mac, ` +
      `check whether the proxy allows workers.dev.`,
  );
}

async function assertAuthorized(o: {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const res = await o.fetchImpl(`${o.baseUrl}/machines`, {
    headers: { authorization: `Bearer ${o.token}` },
  });
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `the Worker is reachable but rejected the token this setup just created. ` +
        `That should be impossible — the same run uploaded it. Run setup again.`,
    );
  }
  throw new Error(
    `the Worker is reachable but an authenticated read answered ${String(res.status)}.`,
  );
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

function readablePlainText(
  bindings: readonly ReadBinding[] | null,
  name: string,
): string | null {
  const hit = bindings?.find((b) => b.name === name);
  if (hit === undefined || hit.type !== "plain_text") return null;
  return hit.text === null || hit.text === "" ? null : hit.text;
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
