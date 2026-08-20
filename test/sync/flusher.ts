/**
 * Every flusher a sync test makes, stopped before the test ends.
 *
 * A flusher owns two things that can outlive the test that created it: a
 * backoff timer, and — once a drain is past its first `await` — an open read
 * over the database. Neither is reachable from the test. The retry is launched
 * as `void flush()` from inside the timer, so there is no promise for an
 * `await` to hold, and `flusher.cancel()` at the end of a test body never runs
 * at all if an assertion above it fails.
 *
 * Registering the teardown at construction is what makes that structural: a
 * flusher created through this function cannot be left running, whatever the
 * test then does or fails to do. It is the reason a `db.close()` in a later
 * test cannot be reached by an earlier test's continuation.
 */
import { onTestFinished } from "vitest";

import { createFlusher, type Flusher, type FlusherDeps } from "../../src/sync/flush";

export function testFlusher(deps: FlusherDeps): Flusher {
  const flusher = createFlusher(deps);
  onTestFinished(async () => {
    await flusher.stop();
  });
  return flusher;
}
