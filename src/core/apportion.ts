/**
 * Largest-remainder apportionment.
 *
 * PURE, like everything else in src/core/: no clock, no electron, no database.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The "This week" bars are stacked per machine, and the stack has to come to
 * the bar. The bar is the day's UNION across machines — the same figure the
 * "This week" stat card four inches up the page adds together — so a stack that
 * summed to something else would put two contradicting numbers on one screen
 * with nothing anywhere reporting an error. That is the exact shape of failure
 * `docs/DATA_MODEL.md` wrote the union merge to prevent, reintroduced by a
 * rounding step.
 *
 * And rounding each share on its own does reintroduce it. Two machines credited
 * 2.505 h each round to 2.50 + 2.50 = 5.00, while their 5.01 h total rounds to
 * 5.01: one hundredth of an hour that exists in the total and in neither part.
 *
 * So the total is decided FIRST and then handed out. Every part takes its floor
 * and the remainder goes one unit at a time to the parts that lost the most to
 * that floor. The result sums to `total` by construction rather than by luck,
 * which is what lets `metrics.ts` state the invariant as a fact.
 *
 * Everything here is integers — hundredths of an hour — because the invariant
 * is an equality and floating-point hours cannot carry one.
 */

/**
 * Split `total` across `weights`, proportionally, summing to EXACTLY `total`.
 *
 * `weights` are relative and may be any non-negative numbers (milliseconds, in
 * practice). `total` must be an integer; the returned parts are integers in the
 * same unit as `total`, never in the unit of the weights.
 *
 * Ties in the remainder go to the earlier weight, so the same input always
 * produces the same output — the bars must not reshuffle between two renders of
 * the same data.
 */
export function apportion(weights: readonly number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safe.reduce((a, w) => a + w, 0);

  if (sum === 0) {
    // No weights at all. A non-zero total here would be time belonging to
    // nobody; it goes to the first part rather than silently evaporating,
    // because a stack shorter than its bar is the failure this file prevents.
    const out = new Array<number>(n).fill(0);
    out[0] = total;
    return out;
  }

  const exact = safe.map((w) => (w / sum) * total);
  const out = exact.map((x) => Math.floor(x));

  // Most-owed first. `frac` is what the floor took away from that part.
  const owed = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  // `left` is never negative and never exceeds `n`: every `exact_i` is at least
  // its own floor, so the floors sum to at most `total`, and each one is short
  // by less than a whole unit. The loop is still bounded rather than
  // `while (left > 0)`, so a caller who hands it a fractional total gets a
  // wrong-but-terminating answer instead of a hung renderer.
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0 && k < owed.length; k++) {
    out[owed[k]!.i]! += 1;
    left -= 1;
  }

  return out;
}
