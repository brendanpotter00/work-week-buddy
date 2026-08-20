/**
 * The reconciliation fingerprint — layer 3 of the four backup layers, and the
 * only one that catches *silent* loss. Without it the other layers are theatre,
 * because nobody ever learns they were needed.
 *
 * ── THE HASH IS DEFINED HERE, ONCE. ─────────────────────────────────────────
 * The client (T4.4) must compute a byte-identical value over its own synced
 * rows. A client and a server that disagree about the joining character produce
 * a permanent, unexplained mismatch alarm that looks exactly like real data
 * loss. So the definition is stated exactly and copied verbatim, never
 * paraphrased:
 *
 *   lowercase hex SHA-256 of every `id` in the table,
 *   sorted ASCII-ascending,
 *   joined with "\n",
 *   no trailing newline,
 *   encoded UTF-8.
 *
 * An empty table hashes the empty string, which is the well-known
 * e3b0c442…b855 — a real value, not a special case.
 */

/**
 * Sorting note: interval ids are UUIDv7, so ASCII. JavaScript's default sort
 * compares UTF-16 code units, which for ASCII is identical to ASCII-ascending
 * and to SQLite's default BINARY collation. Sorting here rather than trusting
 * the query's ORDER BY is deliberate — it makes the digest independent of both
 * insert order and collation, which is the property the whole check rests on.
 */
export async function fingerprintSha256(
  ids: readonly string[],
): Promise<string> {
  const canonical = [...ids].sort().join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
