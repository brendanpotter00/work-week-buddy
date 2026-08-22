/**
 * Which credential does this look like?
 *
 * There are two, they do different things, and pasting one into the other's
 * field is one of the four onboarding failures watched live. The structural fix
 * is that they are no longer adjacent — this Mac's sync token is behind a
 * disclosure in Settings, the Cloudflare API token is in a different window —
 * and this is the second line: a warning beside the field, before any request.
 *
 *   this Mac's sync token   `randomBytes(32).toString("base64")`
 *                           44 characters, base64 with `+/`, ends in `=`
 *   Cloudflare API token    40 characters, URL-safe base64 with `-_`,
 *                           no padding
 *
 * ── IT NEVER ECHOES THE VALUE ───────────────────────────────────────────────
 * This runs on a LIVE SECRET in a renderer. It returns an enum and nothing
 * else: no substring, no length, no redacted form. Nothing here may put the
 * value in React state, in a message, or in the DOM — which is the same rule
 * the fields themselves keep by staying uncontrolled.
 *
 * ── IT WARNS, AND NEVER BLOCKS ──────────────────────────────────────────────
 * A heuristic, deliberately. Refusing a value we might be wrong about is worse
 * than letting a wrong-looking one through to a 401 that says what happened, so
 * every caller renders this as a note beside the field and keeps the button
 * live.
 */

export type CredentialShape = "sync-token" | "cloudflare-api-token" | "url" | "unknown";

/** 32 bytes of base64: 43 characters of payload plus one `=` of padding. */
const SYNC_TOKEN = /^[A-Za-z0-9+/]{43}=$/;

/** Cloudflare's own: 40 URL-safe base64 characters, no padding. */
const CLOUDFLARE_API_TOKEN = /^[A-Za-z0-9_-]{40}$/;

/** Enough of a URL to be sure it is not a credential. */
const URLISH = /^(https?:\/\/|\/\/)/i;

export function classifyCredential(raw: string): CredentialShape {
  const value = raw.trim();
  if (value === "") return "unknown";
  if (URLISH.test(value)) return "url";
  // Order matters only in that the two token patterns cannot both match: one is
  // 44 characters ending in `=`, the other is 40 with no padding.
  if (SYNC_TOKEN.test(value)) return "sync-token";
  if (CLOUDFLARE_API_TOKEN.test(value)) return "cloudflare-api-token";
  return "unknown";
}
