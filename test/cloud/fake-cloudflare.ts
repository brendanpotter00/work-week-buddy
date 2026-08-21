/**
 * A Cloudflare you can break on purpose.
 *
 * Small, and deliberately not a mock of `CloudflareApi`: it is an HTTP surface
 * that `createCloudflareApi` is pointed at, so every test exercises the real
 * paths, the real multipart body, the real `?bindings_inherit=strict`, the real
 * envelope parsing and the real error mapping. A mock of the interface would
 * have proved that `bringup.ts` calls methods, which is not the part that can
 * be wrong.
 *
 * It models the three behaviours the whole feature turns on:
 *
 *   bindings are REPLACED     an upload's `bindings` array is the new set. This
 *                             is what makes forgetting the other Mac's token
 *                             delete it, and it is why the tests can prove the
 *                             `inherit` binding actually preserves it.
 *   secrets are WRITE-ONLY    `secret_text` values never come back out, from
 *                             any endpoint. `plain_text` values do. That
 *                             asymmetry is the whole of `slot.ts`.
 *   inherit is STRICT         an `inherit` naming a binding the previous
 *                             version does not have fails the upload — but only
 *                             because the request asked for `strict`. Without
 *                             the flag Cloudflare drops it silently, and the
 *                             fake drops it silently too, so a test can prove
 *                             the flag is what saves us.
 *
 * The tokens and ids in here are obvious nonsense. AGENTS.md: no real
 * credential, account id or database id in a tracked file, ever.
 */
import { WORKER_SCHEMA_SQL } from "../../src/cloud/worker-bundle.generated";

export const FAKE_API_TOKEN = "not-a-real-cloudflare-api-token-aaaaaaaaaaaa";
export const FAKE_ACCOUNT_ID = "00000000000000000000000000000001";
export const FAKE_ACCOUNT_NAME = "Test Account";
export const FAKE_SUBDOMAIN = "test-subdomain";
export const FAKE_BASE = "https://fake-cloudflare.test/client/v4";

/** This Mac, and the other one. Neither is a real IOPlatformUUID. */
export const THIS_MAC = "00000000-0000-0000-0000-00000000AAAA";
export const OTHER_MAC = "00000000-0000-0000-0000-00000000BBBB";

export interface StoredBinding {
  type: string;
  name: string;
  /** Present for plain_text and d1. Never returned for secret_text. */
  text?: string;
  database_id?: string;
}

export interface UploadRecord {
  scriptName: string;
  strict: boolean;
  mainModule: string;
  compatibilityDate: string;
  script: string;
  bindings: StoredBinding[];
}

interface Database {
  uuid: string;
  name: string;
  /** machine_id values the Worker has stamped, as if by real traffic. */
  machineRows: string[];
  intervalRows: string[];
  schemaApplied: boolean;
}

export class FakeCloudflare {
  /** Accounts this token may enumerate. Empty models a token that may not. */
  accounts: Array<{ id: string; name: string }> = [
    { id: FAKE_ACCOUNT_ID, name: FAKE_ACCOUNT_NAME },
  ];
  /** `active`, or anything else to model an expired or disabled token. */
  tokenStatus = "active";
  /** Null models an account that has never claimed a workers.dev subdomain. */
  subdomain: string | null = FAKE_SUBDOMAIN;
  databases: Database[] = [];
  /** null until something has been uploaded. */
  script: { bindings: StoredBinding[]; body: UploadRecord } | null = null;
  workersDevEnabled = false;

  /** Every request, so a test can assert what was and was not called. */
  readonly calls: Array<{ method: string; path: string }> = [];
  readonly uploads: UploadRecord[] = [];

  /** Permission names this token does NOT have. A matching call answers 403. */
  readonly denied = new Set<string>();
  /** `path substring -> status`, so any one call can be made to fail once. */
  failOnce = new Map<string, number>();
  /** The fetch rejects entirely — no network. */
  offline = false;

  /** Seed an existing deployment, the way the owner's live account looks. */
  seedDatabase(name: string, uuid = "db-uuid-0000-0000-0000-000000000001"): Database {
    const db: Database = {
      uuid,
      name,
      machineRows: [],
      intervalRows: [],
      schemaApplied: false,
    };
    this.databases.push(db);
    return db;
  }

  seedScript(bindings: StoredBinding[]): void {
    this.script = {
      bindings,
      body: {
        scriptName: "wwb-sync",
        strict: true,
        mainModule: "index.js",
        compatibilityDate: "2026-08-01",
        script: "// seeded",
        bindings,
      },
    };
  }

  /** What a binding's value actually is right now — the test's x-ray. */
  bindingValue(name: string): string | undefined {
    const b = this.script?.bindings.find((x) => x.name === name);
    return b?.text ?? b?.database_id;
  }

  bindingNames(): string[] {
    return (this.script?.bindings ?? []).map((b) => b.name).sort();
  }

  /** A `fetch` to hand to `createCloudflareApi`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/client\/v4/, "");
    this.calls.push({ method, path });

    if (this.offline) throw new TypeError("fetch failed");

    for (const [needle, status] of this.failOnce) {
      if (path.includes(needle)) {
        this.failOnce.delete(needle);
        return err(status, [{ code: 10000, message: "injected failure" }]);
      }
    }

    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${FAKE_API_TOKEN}`) {
      return err(401, [{ code: 10002, message: "Unauthorized" }]);
    }

    return await this.route(method, path, url, init);
  };

  private deny(permission: string): Response | null {
    return this.denied.has(permission)
      ? err(403, [{ code: 10000, message: "Authentication error" }])
      : null;
  }

  private async route(
    method: string,
    path: string,
    url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    // ── token ────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/user/tokens/verify") {
      return ok({ id: "token-id", status: this.tokenStatus });
    }

    // ── accounts ─────────────────────────────────────────────────────────
    if (method === "GET" && path === "/accounts") {
      const denied = this.deny("Account Settings: Read");
      if (denied) return denied;
      return ok(this.accounts);
    }

    const account = /^\/accounts\/([^/]+)(.*)$/.exec(path);
    if (account === null) return err(404, [{ code: 7003, message: "no route" }]);
    const [, accountId, rest] = account as unknown as [string, string, string];
    if (!this.accounts.some((a) => a.id === accountId) && this.accounts.length > 0) {
      return err(404, [{ code: 7003, message: "no such account" }]);
    }

    // ── D1 ───────────────────────────────────────────────────────────────
    if (rest === "/d1/database" && method === "GET") {
      const denied = this.deny("D1: Read");
      if (denied) return denied;
      return ok(this.databases.map((d) => ({ uuid: d.uuid, name: d.name })));
    }
    if (rest === "/d1/database" && method === "POST") {
      const denied = this.deny("D1: Edit");
      if (denied) return denied;
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
      const name = body.name ?? "";
      // Cloudflare rejects a duplicate name; modelling that is what turns
      // "creates a second database" from a bad outcome into a failing test.
      if (this.databases.some((d) => d.name === name)) {
        return err(400, [{ code: 7502, message: "database already exists" }]);
      }
      const db = this.seedDatabase(name, `db-uuid-${String(this.databases.length + 1)}`);
      return ok({ uuid: db.uuid, name: db.name });
    }

    const dbQuery = /^\/d1\/database\/([^/]+)\/query$/.exec(rest);
    if (dbQuery !== null && method === "POST") {
      const denied = this.deny("D1: Edit");
      if (denied) return denied;
      const db = this.databases.find((d) => d.uuid === dbQuery[1]);
      if (db === undefined) return err(404, [{ code: 7003, message: "no such database" }]);
      const { sql } = JSON.parse(String(init?.body ?? "{}")) as { sql?: string };
      return ok(this.runSql(db, sql ?? ""));
    }

    // ── Workers ──────────────────────────────────────────────────────────
    const script = /^\/workers\/scripts\/([^/]+)(.*)$/.exec(rest);
    if (script !== null) {
      const [, scriptName, tail] = script as unknown as [string, string, string];

      if (tail === "" && method === "PUT") {
        const denied = this.deny("Workers Scripts: Edit");
        if (denied) return denied;
        return await this.upload(scriptName, url, init);
      }
      if (tail === "/settings" && method === "GET") {
        const denied = this.deny("Workers Scripts: Read");
        if (denied) return denied;
        if (this.script === null) return err(404, [{ code: 10007, message: "not found" }]);
        // SECRETS ARE WRITE-ONLY. A secret_text binding comes back with its
        // name and type and NO text, from this endpoint and every other.
        return ok({
          bindings: this.script.bindings.map((b) =>
            b.type === "secret_text"
              ? { type: b.type, name: b.name }
              : { ...b },
          ),
        });
      }
      if (tail === "/secrets" && method === "GET") {
        const denied = this.deny("Workers Scripts: Read");
        if (denied) return denied;
        if (this.script === null) return err(404, [{ code: 10007, message: "not found" }]);
        return ok(
          this.script.bindings
            .filter((b) => b.type === "secret_text")
            .map((b) => ({ name: b.name, type: "secret_text" })),
        );
      }
      if (tail === "/subdomain" && method === "POST") {
        const denied = this.deny("Workers Scripts: Edit");
        if (denied) return denied;
        if (this.script === null) return err(404, [{ code: 10007, message: "not found" }]);
        const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
        this.workersDevEnabled = body.enabled === true;
        return ok({ enabled: this.workersDevEnabled, previews_enabled: false });
      }
      return err(404, [{ code: 7003, message: "no route" }]);
    }

    if (rest === "/workers/subdomain" && method === "GET") {
      const denied = this.deny("Workers Scripts: Read");
      if (denied) return denied;
      if (this.subdomain === null) return err(404, [{ code: 10007, message: "not found" }]);
      return ok({ subdomain: this.subdomain });
    }
    if (rest === "/workers/subdomain" && method === "PUT") {
      const denied = this.deny("Workers Scripts: Edit");
      if (denied) return denied;
      const body = JSON.parse(String(init?.body ?? "{}")) as { subdomain?: string };
      this.subdomain = body.subdomain ?? null;
      return ok({ subdomain: this.subdomain });
    }

    return err(404, [{ code: 7003, message: "no route" }]);
  }

  /**
   * The upload, with the binding semantics that make this feature dangerous.
   *
   * `bindings` REPLACES the previous set. An `inherit` entry is resolved against
   * the previous version — and when it cannot be, `strict` decides whether that
   * is an error or a silent deletion. Both branches are modelled, because the
   * silent one is the bug and a test has to be able to reach it.
   */
  private async upload(
    scriptName: string,
    url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const strict = url.searchParams.get("bindings_inherit") === "strict";
    const form = init?.body;
    if (!(form instanceof FormData)) {
      return err(400, [{ code: 10021, message: "expected multipart/form-data" }]);
    }
    const metaPart = form.get("metadata");
    if (metaPart === null) {
      return err(400, [{ code: 10021, message: "missing metadata part" }]);
    }
    const meta = JSON.parse(await asText(metaPart)) as {
      main_module?: string;
      compatibility_date?: string;
      bindings?: StoredBinding[];
    };
    const mainModule = meta.main_module ?? "";
    const modulePart = form.get(mainModule);
    if (modulePart === null) {
      return err(400, [
        { code: 10021, message: `main_module "${mainModule}" is not an uploaded part` },
      ]);
    }

    const previous = this.script?.bindings ?? [];
    const next: StoredBinding[] = [];
    for (const b of meta.bindings ?? []) {
      if (b.type !== "inherit") {
        next.push({ ...b });
        continue;
      }
      const carried = previous.find((p) => p.name === b.name);
      if (carried !== undefined) {
        next.push({ ...carried });
        continue;
      }
      if (strict) {
        return err(400, [
          { code: 10021, message: `inherit binding "${b.name}" could not be resolved` },
        ]);
      }
      // Without `strict`, Cloudflare drops it and answers 200. This is the
      // silent data loss the flag exists to prevent.
    }

    const record: UploadRecord = {
      scriptName,
      strict,
      mainModule,
      compatibilityDate: meta.compatibility_date ?? "",
      script: await asText(modulePart),
      bindings: next,
    };
    this.uploads.push(record);
    this.script = { bindings: next, body: record };
    return ok({ id: scriptName });
  }

  /**
   * Just enough SQL.
   *
   * The schema is matched by identity against the embedded file rather than
   * parsed — this fake exists to check the wizard's behaviour, and the SQL
   * itself is exercised for real against `node:sqlite` in `worker/test/`.
   */
  private runSql(db: Database, sql: string): Array<{ success: boolean; results: unknown[] }> {
    if (sql === WORKER_SCHEMA_SQL) {
      db.schemaApplied = true;
      return [{ success: true, results: [] }];
    }
    if (sql.includes("FROM machine") && sql.includes("work_interval")) {
      if (!db.schemaApplied) {
        // Reading a table that does not exist yet is the ordinary first-run
        // answer, and `bringup.ts` has to treat it as "no evidence".
        return [{ success: false, results: [] }];
      }
      return [
        { success: true, results: db.machineRows.map((machine_id) => ({ machine_id })) },
        { success: true, results: db.intervalRows.map((machine_id) => ({ machine_id })) },
        { success: true, results: [{ n: db.intervalRows.length }] },
      ];
    }
    return [{ success: true, results: [] }];
  }
}

async function asText(part: FormDataEntryValue): Promise<string> {
  return typeof part === "string" ? part : await part.text();
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, errors: Array<{ code: number; message: string }>): Response {
  return new Response(JSON.stringify({ success: false, errors, messages: [], result: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A `fetch` that answers the deployed Worker's own routes.
 *
 * `bringup.ts` proves the URL by asking `/health` and then making one
 * authenticated read, so the tests need something at the other end of that. It
 * answers 401 for any token the fake Cloudflare does not currently hold as
 * `TOKEN_PERSONAL` or `TOKEN_WORK`, which is what lets a test prove the token
 * that was just uploaded is the one that works.
 */
export function workerFetchFor(
  cloud: FakeCloudflare,
  opts: { healthFailures?: number; authFailures?: number } = {},
): typeof fetch {
  let remaining = opts.healthFailures ?? 0;
  // A new Worker version reaches every colo in seconds rather than atomically,
  // so an authenticated read right after a redeploy can hit the PREVIOUS
  // version and reject a token that is completely correct.
  let staleVersion = opts.authFailures ?? 0;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.pathname === "/health") {
      if (remaining > 0) {
        remaining -= 1;
        // A workers.dev hostname resolves before its certificate is issued.
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ ok: true, ms: 1 }), { status: 200 });
    }
    if (staleVersion > 0) {
      staleVersion -= 1;
      return new Response("unauthorized", { status: 401 });
    }
    const presented = new Headers(init?.headers).get("authorization") ?? "";
    const live = ["TOKEN_PERSONAL", "TOKEN_WORK"]
      .map((n) => cloud.bindingValue(n))
      .filter((v): v is string => v !== undefined);
    if (!live.some((t) => presented === `Bearer ${t}`)) {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ machines: [] }), { status: 200 });
  };
}
