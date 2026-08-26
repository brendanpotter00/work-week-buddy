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
 * It models the behaviours the feature turns on:
 *
 *   bindings are REPLACED     an upload's `bindings` array is the new set.
 *   secrets are WRITE-ONLY    `secret_text` values never come back out.
 *   inherit is STRICT         an `inherit` naming a binding the previous
 *                             version does not have fails the upload — but only
 *                             because the request asked for `strict`. Without
 *                             the flag Cloudflare drops it silently, and the
 *                             fake drops it silently too, so a test can prove
 *                             the flag is what saves us.
 *   the MACHINE REGISTRY      `machine_token` rows, written and read through
 *                             the D1 query endpoint with BOUND PARAMETERS, so a
 *                             test can prove enrolment binds rather than
 *                             interpolates and that a revoke touches one Mac.
 *   a denial can be 401 OR 403  Cloudflare has answered a missing scope with
 *                             each of them and the error code is overloaded
 *                             across all three cases, so the app must be right
 *                             under either. `denyStatus` picks which.
 *
 * The tokens and ids in here are obvious nonsense. AGENTS.md: no real
 * credential, account id or database id in a tracked file, ever.
 */
import { createHash } from "node:crypto";
import { WORKER_SCHEMA_SQL } from "../../src/cloud/worker-bundle.generated";

export const FAKE_API_TOKEN = "not-a-real-cloudflare-api-token-aaaaaaaaaaaa";
export const FAKE_ACCOUNT_ID = "00000000000000000000000000000001";
export const FAKE_ACCOUNT_NAME = "Test Account";
export const FAKE_SUBDOMAIN = "test-subdomain";
export const FAKE_BASE = "https://fake-cloudflare.test/client/v4";

/**
 * The zones this fake account owns.
 *
 * `.test` is reserved by RFC 6761 and can never be a real domain, so nothing in
 * here can ever accidentally name something that exists. AGENTS.md: no real
 * domain, account id or credential in a tracked file, ever.
 */
export const FAKE_ZONE_ID = "00000000000000000000000000000010";
export const FAKE_ZONE_NAME = "example.test";
export const OTHER_ZONE_ID = "00000000000000000000000000000011";
export const OTHER_ZONE_NAME = "other.test";
/** A zone on somebody ELSE's account, so the client-side filter is exercised. */
export const FOREIGN_ZONE_ID = "00000000000000000000000000000012";
export const FOREIGN_ZONE_NAME = "not-yours.test";

/** This Mac, and another one. Neither is a real IOPlatformUUID. */
export const THIS_MAC = "00000000-0000-0000-0000-00000000AAAA";
export const OTHER_MAC = "00000000-0000-0000-0000-00000000BBBB";

/** The same digest the app and the Worker compute. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

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

/** One row of `machine_token`. The token itself is never here — only a digest. */
export interface RegistryRow {
  tokenSha256: string;
  machineId: string;
  enrolledAtMs: number;
  revokedAtMs: number | null;
}

interface Database {
  uuid: string;
  name: string;
  /** `machine` — the heartbeat's table, joined for a display label. */
  machineRows: Array<{ machineId: string; label: string | null; lastSeenMs: number }>;
  /** `work_interval` ids, for the row count the review screen shows. */
  intervalRows: string[];
  /** `machine_token` — the registry. */
  tokens: RegistryRow[];
  schemaApplied: boolean;
}

/** One row of the account's Worker custom domains. */
export interface WorkerDomainRow {
  id: string;
  cert_id: string;
  hostname: string;
  zone_id: string;
  zone_name: string;
  service: string;
}

/** A recorded request body against the D1 query endpoint. */
export interface QueryBody {
  sql: string;
  params?: string[];
}

export class FakeCloudflare {
  /** Accounts this token may enumerate. Empty models a token that may not. */
  accounts: Array<{ id: string; name: string }> = [
    { id: FAKE_ACCOUNT_ID, name: FAKE_ACCOUNT_NAME },
  ];
  /** `active`, or anything else to model an expired or disabled token. */
  tokenStatus = "active";
  /** Anything but a 200 from `/user/tokens/verify` — models an unknown string. */
  verifyStatus = 200;
  /** Null models an account that has never claimed a workers.dev subdomain. */
  subdomain: string | null = FAKE_SUBDOMAIN;
  databases: Database[] = [];
  /** null until something has been uploaded. */
  script: { bindings: StoredBinding[]; body: UploadRecord } | null = null;
  workersDevEnabled = false;

  /**
   * Zones. Two on this account and one on another, so a client-side filter that
   * stopped working shows up as a test failure rather than as somebody else's
   * domain in a picker.
   */
  zones: Array<{ id: string; name: string; status: string; account: { id: string } }> = [
    { id: FAKE_ZONE_ID, name: FAKE_ZONE_NAME, status: "active", account: { id: FAKE_ACCOUNT_ID } },
    { id: OTHER_ZONE_ID, name: OTHER_ZONE_NAME, status: "active", account: { id: FAKE_ACCOUNT_ID } },
    {
      id: FOREIGN_ZONE_ID,
      name: FOREIGN_ZONE_NAME,
      status: "active",
      account: { id: "00000000000000000000000000000099" },
    },
  ];
  /** Custom domains already attached to Workers. Empty is the first run. */
  workerDomains: WorkerDomainRow[] = [];
  /**
   * Hostnames that already carry a DNS record belonging to something else.
   *
   * Cloudflare REFUSES a custom domain on one of these — code 100117 — rather
   * than overwriting it, and this is how a test reaches that branch.
   */
  dnsRecords: string[] = [];

  /** Every request, so a test can assert what was and was not called. */
  readonly calls: Array<{ method: string; path: string; body?: string }> = [];
  readonly uploads: UploadRecord[] = [];
  /** Every body sent to the D1 query endpoint, in order. */
  readonly queries: QueryBody[] = [];

  /** Permission names this token does NOT have. A matching call is refused. */
  readonly denied = new Set<string>();
  /**
   * What a refusal answers with. BOTH are real: Cloudflare has answered a
   * missing scope with 401 and with 403, and error code 10000 covers "no
   * token", "wrong token" and "insufficient scope" alike. Every test that
   * asserts wording should run under both.
   */
  denyStatus: 401 | 403 = 403;
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
      tokens: [],
      schemaApplied: false,
    };
    this.databases.push(db);
    return db;
  }

  /** Seed a previously deployed script, bindings and all. */
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

  /** Enrol a machine directly, the way a previous run would have left it. */
  seedEnrolment(
    db: Database,
    o: { token: string; machineId: string; label?: string; enrolledAtMs?: number },
  ): void {
    db.schemaApplied = true;
    db.tokens.push({
      tokenSha256: sha256Hex(o.token),
      machineId: o.machineId,
      enrolledAtMs: o.enrolledAtMs ?? 1_760_000_000_000,
      revokedAtMs: null,
    });
    if (o.label !== undefined) {
      db.machineRows.push({
        machineId: o.machineId,
        label: o.label,
        lastSeenMs: 1_760_000_000_000,
      });
    }
  }

  /** Live registry rows across every database. The test's x-ray. */
  liveTokens(): RegistryRow[] {
    return this.databases.flatMap((d) => d.tokens.filter((t) => t.revokedAtMs === null));
  }

  registryRows(): RegistryRow[] {
    return this.databases.flatMap((d) => d.tokens);
  }

  lastQueryBody(): QueryBody | undefined {
    return this.queries.at(-1);
  }

  /** What a binding's value actually is right now — the test's x-ray. */
  bindingValue(name: string): string | undefined {
    const b = this.script?.bindings.find((x) => x.name === name);
    return b?.text ?? b?.database_id;
  }

  bindingNames(): string[] {
    return (this.script?.bindings ?? []).map((b) => b.name).sort();
  }

  /** Every request body sent anywhere, so a secrecy test can scan them all. */
  allRequestBodies(): string {
    return [
      ...this.calls.map((c) => c.body ?? ""),
      ...this.queries.map((q) => JSON.stringify(q)),
      ...this.uploads.map((u) => JSON.stringify(u)),
    ].join("\n");
  }

  /** A `fetch` to hand to `createCloudflareApi`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });

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
      ? err(this.denyStatus, [{ code: 10000, message: "Authentication error" }])
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
      if (this.verifyStatus !== 200) {
        return err(this.verifyStatus, [{ code: 1000, message: "Invalid API Token" }]);
      }
      return ok({ id: "token-id", status: this.tokenStatus });
    }

    // ── zones ────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/zones") {
      const denied = this.deny("Zone: Read");
      if (denied) return denied;
      const wantAccount = url.searchParams.get("account.id");
      const wantName = url.searchParams.get("name");
      return ok(
        this.zones
          .filter((z) => wantAccount === null || z.account.id === wantAccount)
          .filter((z) => wantName === null || z.name === wantName),
      );
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
      const parsed = JSON.parse(String(init?.body ?? "{}")) as QueryBody;
      this.queries.push(parsed);
      return ok(this.runSql(db, parsed.sql ?? "", parsed.params));
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
            b.type === "secret_text" ? { type: b.type, name: b.name } : { ...b },
          ),
        });
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
    // ── Worker custom domains ────────────────────────────────────────────
    if (rest === "/workers/domains" && method === "GET") {
      const denied = this.deny("Workers Scripts: Read");
      if (denied) return denied;
      const wanted = url.searchParams.get("hostname");
      return ok(
        this.workerDomains.filter((d) => wanted === null || d.hostname === wanted),
      );
    }
    if (rest === "/workers/domains" && method === "PUT") {
      const denied = this.deny("Workers Scripts: Edit");
      if (denied) return denied;
      return this.attachDomain(init);
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
   * `PUT /accounts/{id}/workers/domains`.
   *
   * A FAKE THAT FAILS OUR MISTAKES, not one that models Cloudflare. The first
   * check has no counterpart at Cloudflare at all: it refuses any body key this
   * documented endpoint does not have. `override_existing_dns_record` is the
   * one that matters — wrangler sends it on a different, undocumented endpoint,
   * it reads like it could clobber a DNS record belonging to something else on
   * the owner's zone, and the only guarantee worth having is that this app
   * cannot send it even by accident.
   */
  private attachDomain(init: RequestInit | undefined): Response {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const forbidden = Object.keys(body).filter(
      (k) => k.startsWith("override_") || k === "environment",
    );
    if (forbidden.length > 0) {
      return err(400, [
        {
          code: 9999,
          message:
            `this fake refuses flags the documented endpoint does not have: ` +
            `${forbidden.join(", ")}`,
        },
      ]);
    }

    const hostname = String(body["hostname"] ?? "");
    const service = String(body["service"] ?? "");
    const zone =
      typeof body["zone_id"] === "string"
        ? this.zones.find((z) => z.id === body["zone_id"])
        : this.zones.find((z) => z.name === body["zone_name"]);
    if (zone === undefined) {
      return err(400, [
        {
          code: 10025,
          message: `workers.api.error.origin_hostname_mismatch_zone`,
        },
      ]);
    }

    // Something else already answers at that name. Cloudflare refuses; it does
    // not replace. The exact text has already changed once, so nothing in the
    // app may read it — only the code.
    if (this.dnsRecords.includes(hostname)) {
      return err(400, [
        {
          code: 100117,
          message:
            `Hostname '${hostname}' already has externally managed DNS records ` +
            `(A, CNAME, etc).`,
        },
      ]);
    }

    const existing = this.workerDomains.find((d) => d.hostname === hostname);
    if (existing !== undefined) {
      // Already ours: a PUT of the same thing is a no-op that answers with the
      // same record. Attaching to a DIFFERENT Worker is an origin conflict —
      // status and code here are INFERRED, so no test may assert on them.
      if (existing.service !== service) {
        return err(409, [{ code: 100117, message: "origin conflict" }]);
      }
      return ok(existing);
    }

    const row: WorkerDomainRow = {
      id: `domain-${String(this.workerDomains.length + 1)}`,
      cert_id: `00000000-0000-0000-0000-00000000000${String(this.workerDomains.length + 1)}`,
      hostname,
      zone_id: zone.id,
      zone_name: zone.name,
      service,
    };
    this.workerDomains.push(row);
    return ok(row);
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
   * itself is exercised for real against `node:sqlite` in `worker/test/`. The
   * registry statements ARE interpreted, because their parameters and their
   * WHERE clauses are exactly what the tests need to prove.
   */
  private runSql(
    db: Database,
    sql: string,
    params: string[] | undefined,
  ): Array<{ success: boolean; results: unknown[]; error?: string }> {
    if (sql === WORKER_SCHEMA_SQL) {
      db.schemaApplied = true;
      return [{ success: true, results: [] }];
    }

    // ── enrol ───────────────────────────────────────────────────────────
    if (sql.includes("INSERT INTO machine_token")) {
      if (!db.schemaApplied) {
        return [{ success: false, results: [], error: "no such table: machine_token" }];
      }
      const [hash, machineId, enrolledAt] = params ?? [];
      if (hash === undefined || machineId === undefined) {
        return [{ success: false, results: [], error: "missing bound parameters" }];
      }
      if (db.tokens.some((t) => t.tokenSha256 === hash)) {
        // The PRIMARY KEY. A 256-bit collision is not absorbed quietly.
        return [{ success: false, results: [], error: "UNIQUE constraint failed" }];
      }
      db.tokens.push({
        tokenSha256: hash,
        machineId,
        enrolledAtMs: Number(enrolledAt ?? 0),
        revokedAtMs: null,
      });
      return [{ success: true, results: [] }];
    }

    // ── revoke ──────────────────────────────────────────────────────────
    if (sql.includes("UPDATE machine_token")) {
      if (!db.schemaApplied) {
        return [{ success: false, results: [], error: "no such table: machine_token" }];
      }
      const scopedToOthers = sql.includes("token_sha256 <> ?");
      const [at, machineId, keepHash] = params ?? [];
      for (const t of db.tokens) {
        if (t.machineId !== machineId || t.revokedAtMs !== null) continue;
        if (scopedToOthers && t.tokenSha256 === keepHash) continue;
        t.revokedAtMs = Number(at ?? 0);
      }
      return [{ success: true, results: [] }];
    }

    // ── read the registry, plus the interval count ──────────────────────
    if (sql.includes("FROM machine_token")) {
      if (!db.schemaApplied) {
        // Reading a table that does not exist yet is the ordinary first-run
        // answer, and `bringup.ts` has to treat it as "no evidence".
        return [{ success: false, results: [], error: "no such table: machine_token" }];
      }
      const live = db.tokens
        .filter((t) => t.revokedAtMs === null)
        .sort((a, b) => a.enrolledAtMs - b.enrolledAtMs)
        .map((t) => {
          // LEFT JOIN: a Mac that has enrolled but never sent a heartbeat has
          // no `machine` row and must still appear, as its bare id.
          const m = db.machineRows.find((r) => r.machineId === t.machineId);
          return {
            machine_id: t.machineId,
            enrolled_at_ms: t.enrolledAtMs,
            label: m?.label ?? null,
            last_seen_ms: m?.lastSeenMs ?? null,
          };
        });
      return [
        { success: true, results: live },
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
 * authenticated read, so the tests need something at the other end of that.
 *
 * It authenticates the way the real Worker now does: hash what was presented
 * and look the digest up in the REGISTRY. That is what lets a test prove the
 * token this run just enrolled is the one that works — and that a revoked one
 * stops working immediately.
 */
/**
 * How ONE hostname behaves, when a Mac has more than one address to try.
 *
 * This is the fake that proves the whole custom-domain feature: the point of
 * having two addresses is that a given Mac may reach one and not the other, and
 * every interesting case is a difference between two hosts rather than a
 * property of the Worker.
 */
export interface FakeHostBehaviour {
  /** `/health` fails this many times before answering. */
  healthFailures?: number;
  /**
   * This hostname is unreachable from this Mac, for ever. A corporate proxy
   * that drops the connection — which is world 1, the reason this exists.
   */
  blocked?: boolean;
  /**
   * The certificate is not issued yet: fails this many times with `EPROTO`,
   * then answers. Worth WAITING on, unlike everything else here.
   */
  tlsNotReady?: number;
  /**
   * A Cloudflare challenge page: 403 with an HTML body. A custom domain routes
   * through the ZONE, so Bot Fight Mode, a WAF rule or Access on that domain
   * would suddenly apply to sync traffic — and answer a client that cannot
   * solve a challenge with an unsolvable, permanent 403.
   */
  challenge?: boolean;
}

export function workerFetchFor(
  cloud: FakeCloudflare,
  opts: {
    healthFailures?: number;
    authFailures?: number;
    /** Model a Worker whose database has no registry table: 503, not 401. */
    noRegistry?: boolean;
    /** Per-hostname behaviour, keyed by host. Anything absent behaves normally. */
    hosts?: Record<string, FakeHostBehaviour>;
  } = {},
): typeof fetch {
  let remaining = opts.healthFailures ?? 0;
  // A new Worker version reaches every colo in seconds rather than atomically,
  // so an authenticated read right after a redeploy can hit the PREVIOUS
  // version and reject a token that is completely correct.
  let staleVersion = opts.authFailures ?? 0;
  const hostState = new Map<string, { tls: number; health: number }>(
    Object.entries(opts.hosts ?? {}).map(([host, b]) => [
      host,
      { tls: b.tlsNotReady ?? 0, health: b.healthFailures ?? 0 },
    ]),
  );
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const host = opts.hosts?.[url.hostname];
    if (host !== undefined) {
      const state = hostState.get(url.hostname) ?? { tls: 0, health: 0 };
      if (host.blocked === true) {
        // Exactly what undici throws when a proxy drops the connection: the
        // message says nothing and the cause says everything.
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      }
      if (state.tls > 0) {
        state.tls -= 1;
        hostState.set(url.hostname, state);
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EPROTO" } });
      }
      if (state.health > 0) {
        state.health -= 1;
        hostState.set(url.hostname, state);
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        });
      }
      if (host.challenge === true && url.pathname !== "/health") {
        return new Response("<!DOCTYPE html><html><body>Checking your browser…</body></html>", {
          status: 403,
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }
    }
    if (url.pathname === "/health") {
      if (remaining > 0) {
        remaining -= 1;
        // A workers.dev hostname resolves before its certificate is issued.
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ ok: true, ms: 1 }), { status: 200 });
    }
    if (opts.noRegistry === true) {
      return new Response("machine registry unavailable", { status: 503 });
    }
    if (staleVersion > 0) {
      staleVersion -= 1;
      return new Response("unauthorized", { status: 401 });
    }
    const presented = (new Headers(init?.headers).get("authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (presented === "") return new Response("unauthorized", { status: 401 });
    const digest = sha256Hex(presented);
    const live = cloud.liveTokens().some((t) => t.tokenSha256 === digest);
    if (!live) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({ machines: [] }), { status: 200 });
  };
}
