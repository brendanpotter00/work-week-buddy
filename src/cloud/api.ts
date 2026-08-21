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
 * Uploading a Worker REPLACES its bindings, and the per-machine tokens ARE
 * bindings. Preserving the other Mac's token means sending an `inherit` binding
 * for it — and the schema says, verbatim: "Without this, unresolvable inherit
 * bindings are silently dropped."
 *
 * So every upload goes out with `?bindings_inherit=strict`. Without it, the
 * failure mode is precisely the one this project keeps being bitten by: the
 * deploy succeeds, the response is a 200, and the other Mac's token is gone
 * with nothing anywhere saying so. `uploadWorker` cannot be called without it —
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

export interface TokenStatus {
  readonly id: string;
  /** `active` is the only one that works. A token can verify 200 and be expired. */
  readonly status: string;
}

/**
 * One binding as it goes UP.
 *
 * `inherit` is how a value we cannot read survives a redeploy: it names a
 * binding on the previous version and carries it forward untouched. It is the
 * only way to keep the other Mac's token, because Cloudflare will not tell us
 * what that token is.
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
 * marks the secret variant's `text` write-only. That asymmetry is load-bearing
 * for `slot.ts`: it is exactly why the machine ids are stored as plain text and
 * the tokens are not. A machine id is not a secret, and one that can be read
 * back is the difference between detecting which Mac this is and guessing.
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
  /** `POST .../query`. Multiple statements joined by semicolons run as a batch. */
  query(accountId: string, databaseId: string, sql: string): Promise<unknown[][]>;
  /** The deployed script's bindings, or null when there is no such script. */
  getWorkerBindings(accountId: string, scriptName: string): Promise<ReadBinding[] | null>;
  /** Secret binding NAMES. Documented to omit every value. */
  listWorkerSecretNames(accountId: string, scriptName: string): Promise<string[]>;
  /** `PUT .../scripts/{name}?bindings_inherit=strict`. Creates a version and deploys it. */
  uploadWorker(accountId: string, upload: WorkerUpload): Promise<void>;
  /** The account's workers.dev subdomain, or null when none has been claimed. */
  getAccountSubdomain(accountId: string): Promise<string | null>;
  /** Claim one. Only ever called when `getAccountSubdomain` returned null. */
  createAccountSubdomain(accountId: string, subdomain: string): Promise<string>;
  /** Turn this script on at `<script>.<subdomain>.workers.dev`. */
  enableWorkersDev(accountId: string, scriptName: string): Promise<boolean>;
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
      });
    }
    return { status: res.status, result: body.result ?? null };
  }

  return {
    async verifyToken() {
      const { result } = await call("GET", "/user/tokens/verify", {
        operation: "checking the API token",
      });
      const o = asRecord(result);
      return { id: str(o["id"]) ?? "", status: str(o["status"]) ?? "unknown" };
    },

    async listAccounts() {
      // `per_page` has a documented minimum of 5 on this endpoint. Two Macs and
      // one account is the shape here; 50 is the maximum and covers everyone.
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
    },

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
      // One entry per statement in the batch. Each carries its OWN `success`,
      // separate from the envelope's, and a statement can fail inside a 200.
      return asArray(result).map((entry) => {
        const o = asRecord(entry);
        if (o["success"] === false) {
          throw new Error(`a statement failed: ${str(o["error"]) ?? "no reason given"}`);
        }
        return asArray(o["results"]);
      });
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

    async listWorkerSecretNames(accountId, scriptName) {
      const { status, result } = await call(
        "GET",
        `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/secrets`,
        {
          operation: `listing the “${scriptName}” Worker's secrets`,
          permission: PERMISSION.workersRead,
          tolerate: [404],
        },
      );
      if (status === 404) return [];
      return asArray(result)
        .map((raw) => str(asRecord(raw)["name"]) ?? "")
        .filter((n) => n !== "");
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
