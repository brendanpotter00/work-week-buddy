/**
 * What went wrong with a Cloudflare API call, in words the owner can act on.
 *
 * ── "FAILED" IS NOT AN ANSWER ───────────────────────────────────────────────
 * Three things fail here and they need three different fixes, and the owner
 * cannot tell them apart from a spinner that stops:
 *
 *   no network        nothing to fix on Cloudflare; try again on wifi
 *   wrong token       the string is not a valid API token at all
 *   right token,      the token is real and Cloudflare accepted it — it simply
 *   missing scope     lacks ONE permission, and only one, and it has a name
 *
 * The third is the common one and the one a bare "403" wastes an evening on.
 * Every call this app makes is tagged with the permission Cloudflare's own
 * OpenAPI schema says it requires (`x-api-token-group`), so a 403 can name the
 * checkbox that is missing from the token instead of the status code that
 * resulted. `src/main/sync.ts`'s `probeSyncConfig` already draws the same
 * distinction for the Worker URL; this is that idea applied to setup.
 *
 * ── NOTHING HERE MAY CARRY THE TOKEN ────────────────────────────────────────
 * These strings reach a React component, `wwb.log` and, if anything ever goes
 * wrong, a screenshot. The Cloudflare API token is a credential with write
 * access to a real billable account. `redactSecrets()` below is the last line
 * of defence and `test/cloud/secrecy.test.ts` asserts it holds; the first line
 * is that no caller ever puts one in a message.
 */

/** The permission names as the Cloudflare dashboard's token editor spells them. */
export const PERMISSION = {
  workersEdit: "Workers Scripts: Edit",
  workersRead: "Workers Scripts: Read",
  d1Edit: "D1: Edit",
  d1Read: "D1: Read",
  accountRead: "Account Settings: Read",
} as const;

export type PermissionName = (typeof PERMISSION)[keyof typeof PERMISSION];

/** The Cloudflare v4 envelope's error item. `code` and `message` are required. */
export interface CloudflareErrorItem {
  readonly code: number;
  readonly message: string;
}

/**
 * A Cloudflare API call that reached Cloudflare and was refused.
 *
 * `permission` is what a refusal on THIS call means is missing — set by the
 * caller from the operation's documented token group, because the API itself
 * never says which scope it wanted.
 *
 * `tokenVerified` is what makes the wording reliable. See `describeApiFailure`.
 */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: readonly CloudflareErrorItem[];
  readonly operation: string;
  readonly permission: PermissionName | null;
  /** Did `GET /user/tokens/verify` already accept this token, in this run? */
  readonly tokenVerified: boolean;

  constructor(opts: {
    operation: string;
    status: number;
    errors: readonly CloudflareErrorItem[];
    permission?: PermissionName | null;
    tokenVerified?: boolean;
  }) {
    super(describeApiFailure(opts));
    this.name = "CloudflareApiError";
    this.status = opts.status;
    this.errors = opts.errors;
    this.operation = opts.operation;
    this.permission = opts.permission ?? null;
    this.tokenVerified = opts.tokenVerified ?? false;
  }
}

/** The request never got an answer: DNS, a refused socket, a proxy, a timeout. */
export class CloudflareNetworkError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(
      `could not reach api.cloudflare.com while ${operation} ` +
        // NOT `messageOf`. Every one of these is a `TypeError: fetch failed`
        // and the only thing that varies is on `cause` — see
        // `describeFetchFailure`.
        `(${describeFetchFailure(cause)}) — check the network, and on a work Mac ` +
        `check whether the proxy allows api.cloudflare.com`,
    );
    this.name = "CloudflareNetworkError";
    this.operation = operation;
  }
}

/**
 * The sentence a failed call turns into.
 *
 * The status decides the shape and the Cloudflare message is appended rather
 * than replaced — Cloudflare's own text is often the specific part ("database
 * already exists", "invalid script name") and dropping it in favour of a
 * tidier sentence of ours would be throwing away the only detail that varies.
 */
function describeApiFailure(opts: {
  operation: string;
  status: number;
  errors: readonly CloudflareErrorItem[];
  permission?: PermissionName | null;
  tokenVerified?: boolean;
}): string {
  const detail = opts.errors
    .map((e) => `${e.message} [${String(e.code)}]`)
    .join("; ");
  const tail = detail === "" ? "" : ` Cloudflare said: ${redactSecrets(detail)}`;
  const permission = opts.permission ?? null;

  // ── RULE A — NEVER BRANCH ON THE STATUS CODE FOR A SCOPE PROBLEM ───────────
  //
  // This is the fix for the failure that cost an evening, and it contradicts
  // the natural reading of that failure. The owner created a token with one of
  // the three permissions and got:
  //
  //     "Cloudflare did not accept that API token while listing the D1
  //      databases … Authentication error [10000]"
  //
  // which is the 401 branch below — so his missing-D1-permission call came back
  // 401, not 403. Public reports and Cloudflare's own changelog describe a
  // missing scope as 403. Both happen, and error code 10000 is overloaded
  // across "no token", "wrong token" and "insufficient scope", so neither the
  // status nor the code is evidence of anything here.
  //
  // What IS evidence: once GET /user/tokens/verify has answered `active` in
  // this run, the string is a real Cloudflare API token. A token that verified
  // cannot simultaneously be "not a token" — so any later 401 OR 403 is a
  // permission problem. Fixing only the 403 branch would not have fired for the
  // failure that was actually observed.
  if (opts.tokenVerified === true && (opts.status === 401 || opts.status === 403)) {
    return permission === null
      ? `The API token is real — Cloudflare accepted it — but it is not allowed ` +
          `to do this. Something it needs is missing from its permissions.${tail}`
      : `The API token is real — Cloudflare accepted it — but it is missing the ` +
          `“${permission}” permission, which is what ${opts.operation} needs. ` +
          `Edit that token in the Cloudflare dashboard (My Profile → API Tokens), ` +
          `add the permission at the Account level, and paste it again. Do not ` +
          `create a new token: the one you have is fine.${tail}`;
  }

  switch (opts.status) {
    case 400:
      return `Cloudflare rejected the request while ${opts.operation}.${tail}`;
    case 401:
      // Now exclusively the case it is actually right for: the token never
      // verified, so Cloudflare does not recognise the string at all. A
      // permission list cannot fix this one, so do not offer one — sending
      // someone to add a checkbox to a token that does not exist is worse than
      // saying nothing.
      return (
        `Cloudflare did not accept that API token while ${opts.operation}. ` +
        `Check it was copied whole, and that it has not been rolled or deleted ` +
        `in the dashboard.${tail}`
      );
    case 403:
      // Reachable only before the token has verified — i.e. the verify call
      // itself was forbidden.
      return permission === null
        ? `Cloudflare refused that request while ${opts.operation}. The token is ` +
            `valid but is not allowed to do this.${tail}`
        : `The API token is missing the “${permission}” permission, which is what ` +
            `${opts.operation} needs. Edit the token in the Cloudflare dashboard ` +
            `(My Profile → API Tokens), add that permission at the Account level, ` +
            `and paste the token again.${tail}`;
    case 404:
      return `Cloudflare could not find what ${opts.operation} referred to.${tail}`;
    case 429:
      return (
        `Cloudflare is rate-limiting this account (1,200 requests per five ` +
        `minutes, shared with the dashboard). Wait five minutes and run setup ` +
        `again — nothing that already succeeded will be repeated.${tail}`
      );
    default:
      return opts.status >= 500
        ? `Cloudflare had a server error (${String(opts.status)}) while ${opts.operation}. ` +
            `This is on their side; running setup again is safe.${tail}`
        : `Cloudflare answered ${String(opts.status)} while ${opts.operation}.${tail}`;
  }
}

/**
 * Strip anything credential-shaped out of a string bound for a human.
 *
 * A defence in depth, not a licence: no code path is supposed to put a token in
 * a message, and this exists because "supposed to" is how the last one got out.
 * The three shapes are Cloudflare's own API tokens (40 URL-safe base64
 * characters), a `Bearer …` header echoed back in an error body, and the
 * 44-character base64 this app mints for the Worker.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9_-]{40,}={0,2}/g, "***")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "***");
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Codes that mean "this address is not ready YET", as opposed to "this address
 * is wrong".
 *
 * A brand-new hostname resolves before its certificate exists, so the first
 * minute of failures on one is a wait rather than a fault. Everything NOT in
 * here — a refusal, a reset, a 403 — is a real answer, and retrying it for
 * three minutes is a bug rather than patience. `ERR_SSL_*` is a family rather
 * than a list, so use `isTlsNotReady` rather than testing membership by hand.
 */
export const TLS_NOT_READY_CODES: readonly string[] = [
  "EPROTO",
  "ERR_SSL_PROTOCOL_ERROR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ENOTFOUND",
];

/** Is this failure one an address that was created a minute ago would give? */
export function isTlsNotReady(err: unknown): boolean {
  const code = fetchFailureCode(err);
  if (code === null) return false;
  return TLS_NOT_READY_CODES.includes(code) || code.startsWith("ERR_SSL_");
}

/**
 * Why a fetch failed, in words, out of the `cause` nobody reads.
 *
 * `TypeError: fetch failed` is what undici throws for a dead DNS name, a
 * refused socket, a proxy that dropped the connection and a certificate the
 * process does not trust — four problems with four different fixes and ONE
 * message. Measured on Node 22: `err.message` is the literal string "fetch
 * failed" in all four, and everything that distinguishes them is on
 * `err.cause`:
 *
 *     NXDOMAIN        message: "fetch failed"   cause.code: ENOTFOUND
 *     self-signed     message: "fetch failed"   cause.code: DEPTH_ZERO_SELF_SIGNED_CERT
 *     untrusted root  message: "fetch failed"   cause.code: SELF_SIGNED_CERT_IN_CHAIN
 *     wrong hostname  message: "fetch failed"   cause.code: ERR_TLS_CERT_ALTNAME_INVALID
 *
 * That is why the only thing a work Mac could report about a failed setup was
 * `fetch failed`: `messageOf` returns `err.message` and every caller threw the
 * cause away. The four above want four different answers from the owner, and
 * one of them ("a work network that inspects HTTPS traffic") is not something
 * anyone would guess.
 *
 * Electron's `net.fetch` (Chromium's stack) reports the same conditions in a
 * completely different vocabulary, and MEASURED rather than assumed: it sets no
 * `code` and no `cause` at all, and puts everything in the message —
 * `Error("net::ERR_NAME_NOT_RESOLVED")`. Both are handled, so the sentence does
 * not change when the network stack does. The two TRUST failures are the one
 * place they must not collapse together: Chromium reads the macOS trust store
 * and Node does not, so the same symptom means opposite things on the two
 * stacks. See `sentenceForCode`.
 *
 * Redacted like everything else in this file: a cause message is a string from
 * a library, and this one reaches a screen.
 */
export function describeFetchFailure(err: unknown): string {
  const code = fetchFailureCode(err);
  if (code !== null) {
    const sentence = sentenceForCode(code);
    // An unrecognised code is still worth vastly more than "fetch failed" — it
    // is the thing to paste into a search. Shown bare rather than dressed up.
    return sentence ?? redactSecrets(code);
  }
  // No code anywhere on the chain. Either this is not a fetch failure at all —
  // in which case `err.message` already reads as a sentence and replacing it
  // would be a downgrade — or it is one with nothing but a message on it.
  const message = deepestMessage(err);
  return message === "" ? "no reason given" : redactSecrets(message);
}

/**
 * The first string `code` on the error or anywhere down its `cause` chain.
 *
 * Depth-limited and cycle-guarded because a `cause` is whatever the thrower put
 * there, and this runs on a path that must never hang. DOMException carries a
 * NUMERIC `code`, so only strings count — otherwise an abort would be reported
 * as the code `20`.
 */
function fetchFailureCode(err: unknown): string | null {
  for (const link of causeChain(err)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    // `AbortSignal.timeout` rejects with a DOMException whose only identifying
    // mark is its NAME — under Chromium its `code` is the NUMBER 23. It is how
    // every timeout in this app expires, so it cannot be the one failure that
    // reports nothing.
    const name = (link as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return "ABORT_ERR";
    // MEASURED, and not what was expected: Chromium does not use `code` at
    // all. `net.fetch` rejects a dead hostname with a plain
    // `Error("net::ERR_NAME_NOT_RESOLVED")` — no `code`, no `cause`. The whole
    // answer is inside the message, so it is read out of there.
    const message = (link as { message?: unknown }).message;
    if (typeof message === "string") {
      const chromium = /net::(ERR_[A-Z0-9_]+)/.exec(message);
      if (chromium !== null) return chromium[1] ?? null;
    }
  }
  return null;
}

function deepestMessage(err: unknown): string {
  let message = messageOf(err);
  for (const link of causeChain(err)) {
    const m = (link as { message?: unknown }).message;
    if (typeof m === "string" && m !== "") message = m;
  }
  return message;
}

function causeChain(err: unknown): object[] {
  const chain: object[] = [];
  const seen = new Set<unknown>();
  let node: unknown = err;
  // Eight is well past anything undici produces (TypeError → AggregateError →
  // Error is three) and makes a hand-built cycle harmless.
  while (typeof node === "object" && node !== null && chain.length < 8 && !seen.has(node)) {
    seen.add(node);
    chain.push(node);
    const errs = (node as { errors?: unknown }).errors;
    // `AggregateError` is what a multi-address connect failure comes back as,
    // and the real code is on its FIRST member rather than on the aggregate.
    node =
      (node as { cause?: unknown }).cause ??
      (Array.isArray(errs) ? (errs[0] as unknown) : undefined);
  }
  return chain;
}

function sentenceForCode(code: string): string | null {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ERR_NAME_NOT_RESOLVED":
      return "that hostname does not resolve from this Mac — DNS could not find it";
    case "ECONNREFUSED":
    case "ERR_CONNECTION_REFUSED":
      return "the connection was refused";
    case "ECONNRESET":
    case "ERR_CONNECTION_RESET":
    case "ERR_CONNECTION_CLOSED":
      return (
        "the connection was closed mid-request, which on a work Mac usually " +
        "means a proxy dropped it"
      );
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
    case "ERR_CONNECTION_TIMED_OUT":
      return "the connection timed out";
    // ── The two trust failures are NOT the same failure ────────────────────
    // These four are Node's, and Node reads neither the macOS trust store nor
    // the macOS proxy configuration. A corporate MITM root that Chrome trusts
    // is therefore invisible to this process: the app fails and the browser
    // does not, on every hostname, and no custom domain would help.
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return (
        "the TLS certificate was signed by an authority this app does not " +
        "trust. That is the signature of a work network that inspects HTTPS " +
        "traffic — the browser trusts it because macOS does, and this app does " +
        "not read macOS's trust store."
      );
    case "ERR_CERT_AUTHORITY_INVALID":
      // Chromium's, and it means the opposite thing. Chromium DOES read the
      // macOS trust store, so reaching here means macOS does not trust the
      // issuer either and Chrome would refuse the same address. Saying "this
      // app does not read macOS's trust store" here would send the owner
      // hunting a difference that does not exist.
      return (
        "the TLS certificate was signed by an authority this Mac does not " +
        "trust. Chrome would refuse this address too, so this is the " +
        "certificate rather than a difference between this app and the browser."
      );
    case "ERR_PROXY_CONNECTION_FAILED":
    case "ERR_TUNNEL_CONNECTION_FAILED":
      return (
        "the proxy this Mac is configured to use refused the connection or " +
        "could not complete it"
      );
    case "ERR_PROXY_AUTH_REQUESTED":
    case "ERR_PROXY_AUTH_UNSUPPORTED":
      return "the proxy asked for credentials, which this app cannot supply";
    case "ERR_BLOCKED_BY_ADMINISTRATOR":
    case "ERR_BLOCKED_BY_CLIENT":
      return (
        "a policy on this Mac blocked the request outright — that is device " +
        "management rather than the network"
      );
    case "ERR_INTERNET_DISCONNECTED":
      return "this Mac has no network connection at all";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "ERR_CERT_COMMON_NAME_INVALID":
      return "the certificate served does not name that hostname";
    case "CERT_HAS_EXPIRED":
    case "ERR_CERT_DATE_INVALID":
      return "the certificate has expired";
    case "EPROTO":
      return TLS_HANDSHAKE;
    case "ABORT_ERR":
      return "it did not answer within the timeout";
    default:
      // `ERR_SSL_*` is an open family in Chromium rather than a list.
      return code.startsWith("ERR_SSL_") ? TLS_HANDSHAKE : null;
  }
}

const TLS_HANDSHAKE =
  "the TLS handshake failed. On an address created in the last few minutes " +
  "this is normally the certificate still being issued rather than a fault.";

/**
 * The sentence to show for anything thrown out of `src/cloud/`.
 *
 * Redacted at the boundary rather than trusted, because this is the function
 * every UI string and every log line goes through.
 */
export function describeCloudError(err: unknown): string {
  return redactSecrets(messageOf(err));
}
