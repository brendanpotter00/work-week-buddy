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
        `(${redactSecrets(messageOf(cause))}) — check the network, and on a work Mac ` +
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
 * The sentence to show for anything thrown out of `src/cloud/`.
 *
 * Redacted at the boundary rather than trusted, because this is the function
 * every UI string and every log line goes through.
 */
export function describeCloudError(err: unknown): string {
  return redactSecrets(messageOf(err));
}
