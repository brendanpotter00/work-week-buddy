/**
 * Shared fixtures for the reducer tests.
 *
 * Not a `.test.ts` file on purpose: vitest only collects `*.test.ts`, so this
 * is imported, never run, and it stays out of the coverage report.
 */

import type { Config, Effect, OpenInterval, Signal, TrackerState } from "../../src/core/types";
import { NO_SIGNAL } from "../../src/core/types";
import { reduce } from "../../src/core/reduce";

/** A fixed, readable epoch. 2023-11-14T22:13:20.000Z. */
export const T0 = 1_700_000_000_000;

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Deterministic ids, so a failing property-test case is reproducible. */
export function makeConfig(over: Partial<Config> = {}): Config {
  let n = 0;
  return {
    idleTimeoutMs: 15 * MIN,
    minIntervalMs: 90_000,
    cameraOnlyMaxMs: 6 * HOUR,
    newId: () => `id-${n++}`,
    ...over,
  };
}

/** Pull the effects of one kind out of a result, narrowed. */
export function effectsOf<K extends Effect["kind"]>(
  effects: readonly Effect[],
  kind: K,
): Extract<Effect, { kind: K }>[] {
  return effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
}

export interface Run {
  readonly state: TrackerState;
  readonly effects: readonly Effect[];
  /** Every interval persisted across the whole run, in order. */
  readonly persisted: readonly Extract<Effect, { kind: "persist" }>["interval"][];
}

/** Feed a whole signal stream through the reducer. `nowMs` defaults to `atMs`
 *  — the tests that care about late delivery pass their own. */
export function run(
  signals: readonly (Signal | { sig: Signal; nowMs: number })[],
  cfg: Config = makeConfig(),
  start: TrackerState = {
    open: null,
    cameraOn: false,
    micActive: false,
    jiggler: false,
    paused: false,
    deadlineAtMs: null,
  },
): Run {
  let state = start;
  let effects: readonly Effect[] = [];
  const persisted: Extract<Effect, { kind: "persist" }>["interval"][] = [];
  for (const entry of signals) {
    const sig = "sig" in entry ? entry.sig : entry;
    const nowMs = "sig" in entry ? entry.nowMs : sig.atMs;
    const r = reduce(state, sig, cfg, nowMs);
    state = r.state;
    effects = r.effects;
    for (const e of effectsOf(r.effects, "persist")) persisted.push(e.interval);
  }
  return { state, effects, persisted };
}

/** A journalled open interval, as the store would hand one back at boot. */
export function journalled(over: Partial<OpenInterval> = {}): OpenInterval {
  return {
    id: "journalled-1",
    startedAtMs: T0,
    startSource: "input",
    lastRealSignalMs: T0 + 5 * MIN,
    lastInputMs: T0 + 5 * MIN,
    keyEvents: 12,
    mouseEvents: 3,
    cameraMs: 0,
    micMs: 0,
    jigglerMs: 0,
    cameraSinceMs: NO_SIGNAL,
    micSinceMs: NO_SIGNAL,
    jigglerSinceMs: NO_SIGNAL,
    ...over,
  };
}
