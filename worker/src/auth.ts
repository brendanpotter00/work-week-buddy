/**
 * Per-machine bearer tokens.
 *
 * Two properties matter here and they are both structural, not advisory:
 *
 *   1. The comparison is constant-time AND length-independent. Both sides are
 *      hashed to a 32-byte digest first, so the presented token's length never
 *      reaches the comparison and cannot be probed byte by byte.
 *   2. The machine id comes FROM THE TOKEN. The request body is never consulted
 *      for it, so a stolen work token cannot forge personal rows — see
 *      `stampedMachineId` and its single caller in routes.ts.
 */

import type { Env } from "./types.js";

export type MachineSlot = "personal" | "work";

/** `Bearer <token>`, scheme case-insensitive per RFC 7235. */
const BEARER = /^Bearer[ \t]+(.+)$/i;

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
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
 * The slot this token belongs to, or null.
 *
 * Every configured slot is compared even after a match, so which token was
 * presented cannot be inferred from how long the request took.
 */
export async function authenticate(
  req: Request,
  env: Env,
): Promise<MachineSlot | null> {
  const presented = presentedToken(req);
  if (!presented) return null;

  const digest = await sha256(presented);
  const slots: ReadonlyArray<readonly [MachineSlot, string]> = [
    ["personal", env.TOKEN_PERSONAL],
    ["work", env.TOKEN_WORK],
  ];

  let matched: MachineSlot | null = null;
  for (const [slot, secret] of slots) {
    // An unset secret is not a credential. Without this guard a Worker deployed
    // before `wrangler secret put` would authenticate the empty string.
    if (!secret) continue;
    if (timingSafeEqual(digest, await sha256(secret))) matched = slot;
  }
  return matched;
}

/**
 * The `machine_id` stamped onto every row this token writes.
 *
 * docs/DATA_MODEL.md defines machine_id as the Mac's IOPlatformUUID, so the
 * real mapping lives in env. It falls back to the slot name so a Worker that is
 * deployed before the ids are known still produces coherent, self-consistent
 * rows rather than empty strings.
 */
export function stampedMachineId(env: Env, slot: MachineSlot): string {
  const configured =
    slot === "personal" ? env.MACHINE_ID_PERSONAL : env.MACHINE_ID_WORK;
  return configured && configured.length > 0 ? configured : slot;
}
