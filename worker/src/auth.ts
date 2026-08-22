/**
 * Per-machine bearer tokens, held as a REGISTRY IN D1 rather than as bindings.
 *
 * Three properties matter and they are all structural:
 *
 *   1. The machine id comes FROM THE CREDENTIAL. The request body is never
 *      consulted for it, so a stolen token cannot forge another machine's rows
 *      — see the forgery guard in routes.ts, which is unchanged.
 *   2. The comparison is length-independent: both sides become a 64-character
 *      digest before anything is compared, so the presented token's length
 *      never reaches a comparison and cannot be probed byte by byte.
 *   3. The Worker only ever READS this table. Enrolment and revocation are D1
 *      REST writes made with the Cloudflare API token, so a leaked bearer token
 *      cannot mint an identity or take another Mac offline.
 *
 * Why an indexed lookup is not a timing oracle. The value fed to the index is
 * SHA-256(presented), so to learn anything from how long the B-tree probe takes
 * an attacker would have to steer that digest toward a stored one — a
 * chosen-prefix preimage attack on SHA-256, which is precisely what SHA-256 is
 * for. Response time varies with the number of live rows only through index
 * depth, which is neither secret nor per-request.
 */

import type { Env } from "./types.js";

/** `Bearer <token>`, scheme case-insensitive per RFC 7235. */
const BEARER = /^Bearer[ \t]+(.+)$/i;

/**
 * Thrown when the registry table cannot be read at all.
 *
 * A missing table is a deployment that was never finished, and it must not read
 * as "your token is wrong" — that is the exact failure class this project is
 * organised around. index.ts maps this to a 503 with a sentence, not a 401 that
 * sends someone off to re-copy a perfectly good token.
 */
export class RegistryUnavailable extends Error {
  constructor(cause: unknown) {
    super(`the machine registry could not be read: ${String(cause)}`);
    this.name = "RegistryUnavailable";
  }
}

/** 64 lowercase hex characters — the one format the registry stores. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time compare of two equal-length digests.
 *
 * Workers expose `crypto.subtle.timingSafeEqual`; Node does not, and the tests
 * run on Node so the SQL can be exercised against `node:sqlite` in D1's own
 * dialect. The fallback is the standard XOR-accumulate: it touches every byte
 * of both inputs and branches on nothing derived from their contents.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    // The platform primitive still requires equal lengths to be meaningful.
    if (a.byteLength !== b.byteLength) return false;
    return subtle.timingSafeEqual(a, b);
  }
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Extract the presented token, or "" if the header is absent or malformed. */
export function presentedToken(req: Request): string {
  const match = BEARER.exec(req.headers.get("authorization") ?? "");
  return match?.[1]?.trim() ?? "";
}

/**
 * The machine this token IS, or null.
 *
 * Returns the machine_id directly. `stampedMachineId` is gone, and with it the
 * slot-name fallback that used to stamp the literal word "work" onto real rows.
 * A registry row whose machine_id is empty authenticates NOBODY: stamping "" on
 * a year of history is the silent misattribution this design exists to prevent,
 * and a blank id is not better than a 401.
 */
export async function authenticate(
  req: Request,
  env: Env,
): Promise<string | null> {
  const presented = presentedToken(req);
  if (presented === "") return null;

  const hex = await sha256Hex(presented);
  let row: { token_sha256: string; machine_id: string } | null;
  try {
    row = await env.DB.prepare(
      `SELECT token_sha256, machine_id FROM machine_token
        WHERE token_sha256 = ? AND revoked_at_ms IS NULL`,
    )
      .bind(hex)
      .first<{ token_sha256: string; machine_id: string }>();
  } catch (err) {
    throw new RegistryUnavailable(err);
  }
  if (row === null) return null;

  // Defence in depth. The index already matched exactly under SQLite's default
  // BINARY collation, so this can only fail if that ever stops being true — but
  // the last word on a credential stays the same constant-time comparison the
  // two-slot design used, over two 64-byte ASCII digests of equal length.
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(hex), enc.encode(row.token_sha256))) {
    return null;
  }

  return row.machine_id === "" ? null : row.machine_id;
}
