/**
 * The Cloudflare v4 REST client — everything `npx wrangler` did, over HTTP.
 *
 * Ten calls, and each one was checked against Cloudflare's published OpenAPI
 * schema rather than written from memory. The schema is the authority for the
 * field names below, and two of them are places the narrative documentation is
 * still wrong:
 *
 *   • A D1 row's id is **`uuid`**, not `id`.
 *   • A D1 binding takes **`database_id`**; the `id` field the
 *     multipart-upload-metadata page still shows is marked deprecated.
 *
 * ── THE ONE FLAG THAT MATTERS MOST ──────────────────────────────────────────
 * Uploading a Worker REPLACES its bindings. That used to be dangerous here:
 * per-machine tokens WERE bindings, so preserving the other Mac's token meant
 * sending an `inherit` for it, and the schema says verbatim "Without this,
 * unresolvable inherit bindings are silently dropped" — a deploy that succeeds
 * with a 200 and takes the other Mac offline with nothing anywhere saying so.
 *
 * Credentials now live in the `machine_token` table in D1, so there is no
 * longer anything to inherit and nothing an upload can silently delete. The
 * flag STAYS on every upload anyway: it costs nothing and it is the guarantee
 * any future binding will want. `uploadWorker` cannot be called without it —
 * the query string is not a parameter.
 *
 * ── NOTHING HERE LOGS ───────────────────────────────────────────────────────
 * No `console`, no `log`, no request or response body kept. The bearer token on
 * every one of these calls is a credential for a live billable account; the
 * cheapest way for it never to reach a log file is for this module to own no
 * logger. Failures are thrown as values (`errors.ts`) and the caller decides.
 */
import {
  CloudflareApiError,
  CloudflareNetworkError,
  PERMISSION,
  type CloudflareErrorItem,
  type PermissionName,
} from "./errors";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Long enough for a Worker upload on hotel wifi, short enough to give up. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

export interface D1DatabaseSummary {
  /** The schema calls this `uuid`. It is what a D1 binding's `database_id` takes. */
  readonly uuid: string;
  readonly name: string;
}

/** One domain on this Cloudflare account. */
export interface CloudflareZone {
  readonly id: string;
  readonly name: string;
  /** `active` is the only status that serves traffic. Reported, not enforced. */
  readonly status: string;
}

/** One hostname attached to one Worker script. */
export interface WorkerDomain {
  readonly id: string;
  readonly hostname: string;
  readonly zoneId: string;
  readonly zoneName: string;
  /** The SCRIPT this hostname routes to. Ours is `wwb-sync`. */
  readonly service: string;
  /** The edge certificate Cloudflare issued for it. Recorded, never used. */
  readonly certId: string | null;
}

export interface TokenStatus {
  readonly id: string;
  /** `active` is the only one that works. A token can verify 200 and be expired. */
  readonly status: string;
}

/** Whether one permission is present, absent, or could not be determined. */
export type ScopeState = "ok" | "missing" | "unknown";

/**
 * What a token is actually allowed to do, discovered by TRYING.
 *
 * There is no way to ask. Verified against Cloudflare's OpenAPI schema:
 * `GET /user/tokens/verify` returns only `{id, status}` and does NOT return
 * permissions. `GET /user/tokens/{id}`, which does, needs `API Tokens Read` —
 * a permission this app must never request, because it would let the app read
 * the user's other tokens. `GET /user/tokens/permission_groups` is the same.
 *
 * KNOWN LIMITATION, and it is deliberate: a read probe proves Read, not Edit.
 * `GET /accounts/{id}/d1/database` is documented as `["D1 Read","D1 Write"]`,
 * so a token holding only `D1 · Read` passes this and then fails at
 * `createDatabase` (`["D1 Write"]`). This preflight catches "no D1 permission
 * AT ALL", which is the failure that was actually observed; the Read-only case
 * is caught at the first write and named correctly there by Rule A in
 * `errors.ts`.
 */
export interface CloudScopes {
  /** `GET /accounts/{id}/d1/database` — `missing` means it cannot see D1 at all. */
  readonly d1: ScopeState;
  /** `GET /accounts/{id}/workers/subdomain`. */
  readonly workers: ScopeState;
  /** `GET /accounts` — optional; it only decides whether we can list accounts. */
  readonly accountRead: ScopeState;
  /**
   * `GET /zones` — optional, and it decides LESS than it looks like it does.
   *
   * `missing` means setup cannot LIST your domains. It does not mean you cannot
   * use one: attaching is authorised by `Workers Scripts: Edit`, which the token
   * already has, and the request can carry `zone_name` in place of `zone_id`.
   * So this chooses between a picker and a text field on the review screen, and
   * nothing else.
   */
  readonly zones: ScopeState;
}

/**
 * One binding as it goes UP.
 *
 * `inherit` is how a value we cannot read survives a redeploy: it names a
 * binding on the previous version and carries it forward untouched. Nothing
 * uses it any more — the Worker's only binding is `DB`, whose value we always
 * know — but the variant stays because the strict-inherit contract in
 * `uploadWorker` is only meaningful if an `inherit` can be expressed at all.
 */
export type WorkerBinding =
  | { readonly type: "d1"; readonly name: string; readonly database_id: string }
  | { readonly type: "secret_text"; readonly name: string; readonly text: string }
  | { readonly type: "plain_text"; readonly name: string; readonly text: string }
  | { readonly type: "inherit"; readonly name: string };

/**
 * One binding as it comes BACK.
 *
 * `text` is present for `plain_text` and absent for `secret_text` — the schema
 * marks the secret variant's `text` write-only. Read only to answer "does this
 * Worker exist yet"; the app no longer stores anything in a binding but the
 * database id, so there is nothing here worth interpreting.
 */
export interface ReadBinding {
  readonly type: string;
  readonly name: string;
  readonly text: string | null;
}

export interface WorkerUpload {
  readonly scriptName: string;
  /** The single ES module, from `worker-bundle.generated.ts`. */
  readonly script: string;
  readonly mainModule: string;
  readonly compatibilityDate: string;
  readonly bindings: readonly WorkerBinding[];
}

export interface CloudflareApi {
  /** `GET /user/tokens/verify`. Throws on anything but an accepted token. */
  verifyToken(): Promise<TokenStatus>;
  /**
   * `GET /accounts`.
   *
   * Cloudflare's schema lists only API-key auth for this one, so a token that
   * cannot call it is an ordinary outcome rather than a defect: this resolves
   * to an EMPTY LIST on 401/403 and the caller falls back to asking for the
   * account id, which the dashboard shows on every account's overview page.
   */
  listAccounts(): Promise<CloudflareAccount[]>;
  listDatabases(accountId: string): Promise<D1DatabaseSummary[]>;
  createDatabase(accountId: string, name: string): Promise<D1DatabaseSummary>;
  /**
   * `POST .../query` with a CONSTANT statement. Multiple statements joined by
   * semicolons run as a batch.
   *
   * Use this only for SQL that contains no value from anywhere. Anything with a
   * value in it goes through `queryParams`.
   */
  query(accountId: string, databaseId: string, sql: string): Promise<unknown[][]>;
  /**
   * `POST .../query` with BOUND PARAMETERS. One statement, no semicolons.
   *
   * Added because `query()` string-interpolates. That was harmless while every
   * caller passed a constant, but enrolment puts a machine id and a digest into
   * a statement, and interpolating those is an injection site — and would break
   * outright on any value containing a quote.
   */
  queryParams(
    accountId: string,
    databaseId: string,
    sql: string,
    params: readonly string[],
  ): Promise<unknown[][]>;
  /** Two tolerant GETs that create nothing and change nothing. See `CloudScopes`. */
  probeScopes(accountId: string): Promise<CloudScopes>;
  /** The deployed script's bindings, or null when there is no such script. */
  getWorkerBindings(accountId: string, scriptName: string): Promise<ReadBinding[] | null>;
  /** `PUT .../scripts/{name}?bindings_inherit=strict`. Creates a version and deploys it. */
  uploadWorker(accountId: string, upload: WorkerUpload): Promise<void>;
  /** The account's workers.dev subdomain, or null when none has been claimed. */
  getAccountSubdomain(accountId: string): Promise<string | null>;
  /** Claim one. Only ever called when `getAccountSubdomain` returned null. */
  createAccountSubdomain(accountId: string, subdomain: string): Promise<string>;
  /** Turn this script on at `<script>.<subdomain>.workers.dev`. */
  enableWorkersDev(accountId: string, scriptName: string): Promise<boolean>;
  /**
   * `GET /zones?account.id=…` — the domains this token can see.
   *
   * `account.id` is dotted, and that is not a typo: it is what the published
   * schema says and what wrangler's own `zones.ts` sends. The result is filtered
   * again HERE on `account.id`, for the reason `findDatabase` documents about
   * the D1 `name` filter — a server-side filter that silently matched the wrong
   * thing would present an account's zones as somebody else's.
   *
   * Resolves to an EMPTY LIST on 401/403, exactly like `listAccounts`. A token
   * without `Zone: Read` is an ordinary supported state: the wizard asks for the
   * domain name instead. An empty list is never an error.
   */
  listZones(accountId: string): Promise<CloudflareZone[]>;
  /**
   * `GET /accounts/{id}/workers/domains?hostname=…` — is this hostname taken?
   *
   * THREE OUTCOMES, THREE VALUES, and the third is the point:
   *
   *   undefined   nothing is attached there — it is free
   *   a record    something is attached there, and `service` says what
   *   null        the token may not look, so this does not KNOW
   *
   * "Nothing there" and "cannot tell" must not be the same value, or a caller
   * would attach a hostname it had never actually checked. In practice a token
   * that can deploy can also read these — both are `Workers Scripts` — so `null`
   * should be unreachable. It is modelled anyway, because "should be
   * unreachable" is how the last one got out.
   */
  findWorkerDomain(
    accountId: string,
    hostname: string,
  ): Promise<WorkerDomain | null | undefined>;
  /**
   * Every custom domain on the account, so the review screen can say "that name
   * belongs to something else" BEFORE anything is created.
   *
   * Tolerant like `listZones`: 401/403 is an empty list, because not being able
   * to warn early is not a reason to refuse to run. The attach itself still
   * checks — that is the check that decides — and this one only buys the owner
   * a better moment to find out.
   */
  listWorkerDomains(accountId: string): Promise<WorkerDomain[]>;
  /**
   * `PUT /accounts/{id}/workers/domains` — attach one hostname to one script.
   *
   * THE DOCUMENTED, SINGLE-HOSTNAME FORM, DELIBERATELY. wrangler uses a bulk
   * `/workers/scripts/{script}/domains/records` spelling that appears NOWHERE in
   * Cloudflare's published OpenAPI schema and whose body carries
   * `override_existing_dns_record` — the flag that reads like it could overwrite
   * a DNS record belonging to something else on the owner's zone. This form has
   * no such field, so a conflict FAILS (code 100117) instead of replacing. The
   * zone this points at may already host unrelated services on other hostnames;
   * that is not a thing to be careful about, it is a thing to make impossible.
   *
   * `environment` is NOT sent. The generated SDK's example shows it and
   * wrangler's older path uses it; the schema marks it `deprecated, readOnly`.
   * The schema has been right all three previous times this project has caught
   * the two disagreeing.
   *
   * Exactly one of `zone.id` / `zone.name` goes out. `zone.name` is the path
   * that needs no `Zone: Read` at all.
   */
  attachWorkerDomain(
    accountId: string,
    o: {
      hostname: string;
      service: string;
      zone: { readonly id: string } | { readonly name: string };
    },
  ): Promise<WorkerDomain>;
}

export interface CloudflareApiConfig {
  /**
   * The Cloudflare API token.
   *
   * Held for the lifetime of this object and never written anywhere. The object
   * is created per wizard run and dropped when the run ends, which is the whole
   * of the token's lifetime in this process.
   */
  readonly apiToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

interface Envelope {
  readonly success?: unknown;
  readonly errors?: unknown;
  readonly result?: unknown;
}

export function createCloudflareApi(cfg: CloudflareApiConfig): CloudflareApi {
  const base = (cfg.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * Has `GET /user/tokens/verify` accepted this token during this run?
   *
   * Stamped onto every error so `describeApiFailure` can apply Rule A: a token
   * that verified cannot also be "not a token", so any later 401 *or* 403 is a
   * permission problem. This flag is the only evidence that survives; the
   * status code is not. See the long comment in `errors.ts`.
   */
  let tokenVerified = false;

  /**
   * One call, one envelope, one answer.
   *
   * `operation` is a fragment that reads after "while …" — it is the whole
   * reason a failure can name what was being attempted rather than a URL. It
   * must never contain a value that came from the token or a response.
   */
  async function call(
    method: string,
    path: string,
    opts: {
      operation: string;
      permission?: PermissionName;
      json?: unknown;
      form?: FormData;
      /** Statuses to resolve rather than throw on, e.g. a missing script. */
      tolerate?: readonly number[];
    },
  ): Promise<{ status: number; result: unknown }> {
    const headers = new Headers({ authorization: `Bearer ${cfg.apiToken}` });
    const init: RequestInit = { method, headers };
    if (opts.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      // Deliberately NOT setting content-type: fetch has to append the
      // multipart boundary itself, and a hand-set header loses it.
      init.body = opts.form;
    }
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      // A dead network, a proxy and an abort all land here. There is no
      // reachability probe anywhere in this app; a failed fetch IS the signal.
      throw new CloudflareNetworkError(opts.operation, err);
    }

    const body = await readEnvelope(res);
    if (opts.tolerate?.includes(res.status) === true) {
      return { status: res.status, result: body.result ?? null };
    }
    if (!res.ok || body.success === false) {
      throw new CloudflareApiError({
        operation: opts.operation,
        status: res.status,
        errors: errorItems(body.errors),
        permission: opts.permission ?? null,
        tokenVerified,
      });
    }
    return { status: res.status, result: body.result ?? null };
  }

  /**
   * `GET /accounts`, tolerant of the token not being allowed to enumerate.
   *
   * A local function rather than a method so `probeScopes` can reuse it without
   * going through `this` — the object below is destructured by callers, and a
   * method that depended on its receiver would break the moment one did.
   */
  async function listAccountsImpl(): Promise<CloudflareAccount[]> {
    // `per_page` has a documented minimum of 5 on this endpoint. 50 is the
    // maximum and covers everyone.
    const { status, result } = await call("GET", "/accounts?per_page=50", {
      operation: "listing your Cloudflare accounts",
      permission: PERMISSION.accountRead,
      // Not an error. Cloudflare documents only API-key auth for this route,
      // so a perfectly good token may simply not be allowed to enumerate
      // accounts. The wizard asks for the id instead.
      tolerate: [401, 403],
    });
    if (status === 401 || status === 403) return [];
    return asArray(result)
      .map((row) => {
        const o = asRecord(row);
        return { id: str(o["id"]) ?? "", name: str(o["name"]) ?? "" };
      })
      .filter((a) => a.id !== "");
  }

  return {
    async verifyToken() {
      const { result } = await call("GET", "/user/tokens/verify", {
        operation: "checking the API token",
      });
      const o = asRecord(result);
      const status = str(o["status"]) ?? "unknown";
      // Only `active` counts. A token can verify 200 and be expired or
      // disabled, and an expired token is not evidence that a later refusal is
      // about permissions — it is evidence that the token is finished.
      if (status === "active") tokenVerified = true;
      return { id: str(o["id"]) ?? "", status };
    },

    listAccounts: listAccountsImpl,

    async listDatabases(accountId) {
      const { result } = await call(
        "GET",
        `/accounts/${enc(accountId)}/d1/database?per_page=1000`,
        {
          operation: "listing the D1 databases on this account",
          permission: PERMISSION.d1Read,
        },
      );
      return asArray(result)
        .map(toDatabase)
        .filter((d): d is D1DatabaseSummary => d !== null);
    },

    async createDatabase(accountId, name) {
      const { result } = await call("POST", `/accounts/${enc(accountId)}/d1/database`, {
        operation: `creating the D1 database “${name}”`,
        permission: PERMISSION.d1Edit,
        json: { name },
      });
      const db = toDatabase(result);
      if (db === null) {
        // The schema types every field of the create response as optional, so
        // this is reachable without anything having gone wrong on the wire.
        // Failing here rather than returning an empty id keeps a database that
        // WAS created from being deployed against as "".
        throw new Error(
          `Cloudflare created “${name}” but did not return its id. Run setup ` +
            `again — the second run will find the database and adopt it.`,
        );
      }
      return db;
    },

    async query(accountId, databaseId, sql) {
      const { result } = await call(
        "POST",
        `/accounts/${enc(accountId)}/d1/database/${enc(databaseId)}/query`,
        {
          operation: "running SQL against the D1 database",
          permission: PERMISSION.d1Edit,
          json: { sql },
        },
      );
      return statementResults(result);
    },

    async queryParams(accountId, databaseId, sql, params) {
      const { result } = await call(
        "POST",
        `/accounts/${enc(accountId)}/d1/database/${enc(databaseId)}/query`,
        {
          operation: "running SQL against the D1 database",
          permission: PERMISSION.d1Edit,
          // The whole point: the values travel in `params`, never spliced into
          // `sql`. Verified against Cloudflare's OpenAPI schema — the request
          // body for this endpoint is `{ sql: string, params?: string[] }`.
          json: { sql, params: [...params] },
        },
      );
      return statementResults(result);
    },

    async probeScopes(accountId) {
      // Two GETs the wizard already makes, issued tolerantly and read for their
      // STATUS instead of thrown on. Creates nothing, changes nothing — there
      // is no POST and no PUT on this path, and a test asserts that.
      const read = async (path: string): Promise<ScopeState> => {
        try {
          const { status } = await call("GET", path, {
            operation: "checking what this API token is allowed to do",
            tolerate: [401, 403, 404],
          });
          // 404 is "nothing there", which still proves the token could look.
          return status === 401 || status === 403 ? "missing" : "ok";
        } catch {
          // A network failure says nothing about the token's permissions, and
          // guessing "missing" here would send someone to fix a token that is
          // fine. The caller renders `unknown` as "could not check".
          return "unknown";
        }
      };

      const [d1, workers, zones] = await Promise.all([
        read(`/accounts/${enc(accountId)}/d1/database?per_page=1`),
        read(`/accounts/${enc(accountId)}/workers/subdomain`),
        // Account-filtered so a token scoped to one account does not report
        // somebody else's zones as evidence it can read this one's.
        read(`/zones?account.id=${enc(accountId)}&per_page=1`),
      ]);

      let accountRead: ScopeState;
      try {
        accountRead = (await listAccountsImpl()).length > 0 ? "ok" : "missing";
      } catch {
        accountRead = "unknown";
      }

      return { d1, workers, accountRead, zones };
    },

    async getWorkerBindings(accountId, scriptName) {
      const { status, result } = await call(
        "GET",
        `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/settings`,
        {
          operation: `reading the “${scriptName}” Worker's settings`,
          permission: PERMISSION.workersRead,
          // No such script yet is the first-run state, not a failure.
          tolerate: [404],
        },
      );
      if (status === 404) return null;
      const o = asRecord(result);
      return asArray(o["bindings"]).map((raw) => {
        const b = asRecord(raw);
        return {
          type: str(b["type"]) ?? "",
          name: str(b["name"]) ?? "",
          text: str(b["text"]),
        };
      });
    },

    async uploadWorker(accountId, upload) {
      const metadata = {
        main_module: upload.mainModule,
        compatibility_date: upload.compatibilityDate,
        bindings: upload.bindings,
      };
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      // The part's FIELD NAME is what `main_module` refers to, and the filename
      // has to match it. Both, or the upload resolves no entry point.
      form.append(
        upload.mainModule,
        new Blob([upload.script], { type: "application/javascript+module" }),
        upload.mainModule,
      );
      await call(
        "PUT",
        // `bindings_inherit=strict`. See this file's header — without it an
        // `inherit` that cannot be resolved is DROPPED and the response is 200.
        `/accounts/${enc(accountId)}/workers/scripts/${enc(upload.scriptName)}` +
          `?bindings_inherit=strict`,
        {
          operation: `deploying the “${upload.scriptName}” Worker`,
          permission: PERMISSION.workersEdit,
          form,
        },
      );
    },

    async getAccountSubdomain(accountId) {
      const { status, result } = await call(
        "GET",
        `/accounts/${enc(accountId)}/workers/subdomain`,
        {
          operation: "reading this account's workers.dev subdomain",
          permission: PERMISSION.workersRead,
          // 404 is "this account has never claimed one" — a state to fix, not
          // an error to report.
          tolerate: [404],
        },
      );
      if (status === 404) return null;
      const name = str(asRecord(result)["subdomain"]);
      return name === null || name === "" ? null : name;
    },

    async createAccountSubdomain(accountId, subdomain) {
      const { result } = await call(
        "PUT",
        `/accounts/${enc(accountId)}/workers/subdomain`,
        {
          operation: `claiming the workers.dev subdomain “${subdomain}”`,
          permission: PERMISSION.workersEdit,
          json: { subdomain },
        },
      );
      return str(asRecord(result)["subdomain"]) ?? subdomain;
    },

    async enableWorkersDev(accountId, scriptName) {
      const { result } = await call(
        "POST",
        `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/subdomain`,
        {
          operation: `putting the “${scriptName}” Worker on workers.dev`,
          permission: PERMISSION.workersEdit,
          json: { enabled: true, previews_enabled: false },
        },
      );
      return asRecord(result)["enabled"] === true;
    },

    async listZones(accountId) {
      const { status, result } = await call(
        "GET",
        // Dotted. Confirmed twice: the published schema, and wrangler's
        // `zones.ts`, which builds `{ name, "account.id": accountId }`.
        `/zones?account.id=${enc(accountId)}&per_page=50`,
        {
          operation: "listing the domains on this Cloudflare account",
          permission: PERMISSION.zoneRead,
          tolerate: [401, 403],
        },
      );
      if (status === 401 || status === 403) return [];
      return asArray(result)
        .map((row) => {
          const o = asRecord(row);
          return {
            id: str(o["id"]) ?? "",
            name: str(o["name"]) ?? "",
            status: str(o["status"]) ?? "unknown",
            accountId: str(asRecord(o["account"])["id"]) ?? "",
          };
        })
        .filter((z) => z.id !== "" && z.name !== "" && z.accountId === accountId)
        .map(({ id, name, status: zoneStatus }) => ({ id, name, status: zoneStatus }));
    },

    async findWorkerDomain(accountId, hostname) {
      const { status, result } = await call(
        "GET",
        // `hostname` is a documented filter on this operation. There is no
        // `page`/`per_page` on it — the SDK types the response `SinglePage`.
        `/accounts/${enc(accountId)}/workers/domains?hostname=${enc(hostname)}`,
        {
          operation: `checking whether “${hostname}” is already in use`,
          permission: PERMISSION.workersRead,
          tolerate: [401, 403, 404],
        },
      );
      // Cannot tell. NOT the same as "nothing there" — see the interface.
      if (status === 401 || status === 403) return null;
      const rows = asArray(result);
      const match = rows
        .map((raw) => toWorkerDomain(raw, { hostname, service: "" }))
        // Cloudflare filters server-side; matching again here means a filter
        // that silently stopped working cannot make a taken hostname look free.
        .find((d) => d.hostname === hostname);
      return match;
    },

    async listWorkerDomains(accountId) {
      const { status, result } = await call(
        "GET",
        `/accounts/${enc(accountId)}/workers/domains`,
        {
          operation: "listing the addresses already on this account's Workers",
          permission: PERMISSION.workersRead,
          tolerate: [401, 403, 404],
        },
      );
      if (status !== 200) return [];
      return asArray(result)
        .map((raw) => toWorkerDomain(raw, { hostname: "", service: "" }))
        .filter((d) => d.hostname !== "");
    },

    async attachWorkerDomain(accountId, o) {
      const { result } = await call("PUT", `/accounts/${enc(accountId)}/workers/domains`, {
        operation: `putting the Worker on “${o.hostname}”`,
        permission: PERMISSION.workersEdit,
        // EXACTLY these keys. No `environment` (deprecated + readOnly in the
        // schema), and no `override_*` of any kind — the documented endpoint has
        // no such field, and a hostname that is already spoken for must fail
        // rather than be taken over. A test asserts on the recorded body.
        json: {
          hostname: o.hostname,
          service: o.service,
          ..."id" in o.zone ? { zone_id: o.zone.id } : { zone_name: o.zone.name },
        },
      });
      return toWorkerDomain(result, { hostname: o.hostname, service: o.service });
    },
  };
}

/**
 * `https://<label>.<zone>` — the address the two halves of the review screen
 * add up to.
 */
export function customDomainUrl(label: string, zoneName: string): string {
  return `https://${label.trim()}.${zoneName.trim()}`;
}

/**
 * Is this a hostname label we will send? Returns the reason it is not, or null.
 *
 * One DNS label: 1–63 characters, `a-z0-9-`, no leading or trailing dash. An
 * EMPTY label is rejected ON PURPOSE. Cloudflare accepts "either the zone apex
 * or a subdomain of the zone", which is exactly why this refuses the apex: it is
 * the one name most likely to already be wanted for something else, and taking
 * it over is not a mistake this wizard gets to make on the owner's behalf.
 */
export function hostnameLabelError(label: string): string | null {
  const value = label.trim();
  if (value === "") {
    return (
      "A name is needed. Setup will not take over the domain itself — that is " +
      "the address your other things use."
    );
  }
  if (value.length > 63) {
    return "That is too long for one part of a hostname (63 characters is the limit).";
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "It cannot start or end with a dash.";
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    return "Use lowercase letters, numbers and dashes only — no dots, no spaces. “wwb” is a good one.";
  }
  return null;
}

/**
 * A bare registrable domain, for the path that has no `Zone: Read`.
 *
 * Deliberately loose: this is a spelling check on something the owner is
 * copying from their own Cloudflare dashboard, not an attempt to own the public
 * suffix list. Cloudflare is the authority on whether the zone exists, and it
 * says so in a sentence.
 */
export function zoneNameError(name: string): string | null {
  const value = name.trim().toLowerCase();
  if (value === "") return "Type the domain this should go on.";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) || value.includes("..")) {
    return "That does not look like a domain. It should be something like example.com.";
  }
  return null;
}

/**
 * Read a domain back, every field through `str()`, falling back to what was
 * sent — the same posture `toDatabase` takes, and for the same reason: the
 * schema types most of the response optional, so a missing field is reachable
 * without anything having gone wrong on the wire.
 */
function toWorkerDomain(
  raw: unknown,
  sent: { hostname: string; service: string },
): WorkerDomain {
  const o = asRecord(raw);
  return {
    id: str(o["id"]) ?? "",
    hostname: str(o["hostname"]) ?? sent.hostname,
    zoneId: str(o["zone_id"]) ?? "",
    zoneName: str(o["zone_name"]) ?? "",
    service: str(o["service"]) ?? sent.service,
    certId: str(o["cert_id"]),
  };
}

/**
 * `https://<script>.<subdomain>.workers.dev`.
 *
 * The API does not hand back a URL — `POST .../subdomain` answers
 * `{enabled, previews_enabled}` and nothing else — so this is the only way to
 * name it. What makes it not a guess is that BOTH halves are read back rather
 * than assumed: the subdomain comes from `GET /accounts/{id}/workers/subdomain`
 * and the script name is the one the upload was accepted under. `bringup.ts`
 * then proves the result by fetching `/health` on it before storing it, so a
 * URL that is wrong for any reason never becomes a saved setting.
 */
export function workersDevUrl(scriptName: string, subdomain: string): string {
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

/**
 * A workers.dev subdomain has to be a DNS label: 63 characters, `a-z0-9-`, no
 * leading or trailing dash. Offered as a default when the account has none.
 */
export function toSubdomainLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/**
 * One entry per statement in the batch.
 *
 * Each carries its OWN `success`, separate from the envelope's, and a statement
 * can fail inside a 200 — so a run that ignored this would report a schema
 * applied that never was.
 */
function statementResults(result: unknown): unknown[][] {
  return asArray(result).map((entry) => {
    const o = asRecord(entry);
    if (o["success"] === false) {
      throw new Error(`a statement failed: ${str(o["error"]) ?? "no reason given"}`);
    }
    return asArray(o["results"]);
  });
}

function toDatabase(raw: unknown): D1DatabaseSummary | null {
  const o = asRecord(raw);
  const uuid = str(o["uuid"]) ?? str(o["id"]);
  const name = str(o["name"]);
  if (uuid === null || uuid === "" || name === null) return null;
  return { uuid, name };
}

async function readEnvelope(res: Response): Promise<Envelope> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Envelope) : {};
  } catch {
    // Cloudflare answers HTML for some infrastructure errors. The status still
    // decides; the body is dropped rather than shown, because an HTML page in
    // an error toast tells the reader nothing and could echo the request.
    return {};
  }
}

function errorItems(raw: unknown): CloudflareErrorItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const o = asRecord(entry);
    const code = o["code"];
    return {
      code: typeof code === "number" ? code : 0,
      message: str(o["message"]) ?? "",
    };
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
